// 小说百科网站后端（`story web`）：普通 Node HTTP 服务，零框架。
//
// 复用项目核心不变式：
//  - 唯一数据访问层 = StoryRepo（src/db/repo.ts），每个请求 new 一个 repo 并
//    setUserChapter(n) —— 防剧透过滤发生在数据访问层，与 Ask/Reader 完全同一条路线；
//  - 只暴露结构化知识（实体/别名/事实/关系/能力/事件/记忆锚点/章节标题），
//    与 Reader 一致：**不读 chapters 原文**（正文仅供 Build/import 使用，本文件不含
//    getChapterText / FROM chapters 之类调用，也不把它们暴露给前端）。
//
// 路由：
//   GET /api/state?chapter=N   全书元信息 + 当前进度下的可见数据量
//   GET /api/index?chapter=N   实体分类索引（首页）
//   GET /api/entity?name=X     实体详情档案
//   GET /api/search?q=X        fuzzy 搜索（复用 src/reader/search.ts）
//   其余路径 → web/ 静态文件（SPA）

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StoryRepo, type EntityType } from "../db/repo.js";
import { searchEntities, guessProtagonist } from "../reader/search.js";
import { loadConfig, dbPath } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 前端静态目录：dist/src/web/server.js → 项目根/../..，源码态 src/web/server.ts → ../..
 *  两者取都存在的那一个。 */
function resolveWebDir(): string {
  const candidates = [join(__dirname, "..", "..", "..", "web"), join(__dirname, "..", "web")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
const WEB_DIR = resolveWebDir();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const FACT_TAGLINE_TYPES = ["identity", "role", "occupation", "affiliation", "status"];

export interface WebServerOptions {
  port?: number;
  host?: string;
  cwd?: string; // 项目根（含 .story/），默认 process.cwd()
  quiet?: boolean; // 关闭请求日志
}

export interface WebServerHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 解析章节参数：非法/缺省时回退到 fallback（默认 config.userChapter） */
function parseChapter(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function startWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const db = dbPath(cwd);
  if (!existsSync(db)) {
    throw new Error(`未找到数据库 ${db}，请先运行：story init <小说文件>`);
  }
  const defaultChapter = config.userChapter >= 1 ? config.userChapter : 1;
  const port = opts.port ?? 8765;
  const host = opts.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    void handleRequest(req, res, db, defaultChapter, opts.quiet ?? false);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolvePromise({
        port: actualPort,
        host,
        url: `http://${host}:${actualPort}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dbPath: string,
  defaultChapter: number,
  quiet: boolean
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    const started = Date.now();

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url, dbPath, defaultChapter);
    } else {
      serveStatic(res, pathname);
    }
    if (!quiet) {
      console.log(`[web] ${req.method ?? "GET"} ${pathname}${url.search} ${res.statusCode} ${Date.now() - started}ms`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) sendJson(res, 500, { error: `服务端错误：${msg}` });
    else res.end();
  }
}

// ---------- API ----------

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  dbPath: string,
  defaultChapter: number
): Promise<void> {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "仅支持 GET" });
    return;
  }
  if (pathname === "/api/state") {
    withRepo(dbPath, url, defaultChapter, (repo, bound) => {
      const entities = repo.listEntities();
      const protagonist = guessProtagonist(repo);
      const byType = (t: string) => entities.filter((e) => e.type === t).length;
      sendJson(res, 200, {
        book: repo.installedBook(),
        availableThrough: repo.availableThrough(),
        builtThrough: repo.builtThrough(),
        userChapter: bound,
        defaultChapter,
        protagonist,
        counts: {
          entities: entities.length,
          characters: byType("character"),
          organizations: byType("organization"),
          locations: byType("location"),
          items: byType("item"),
          concepts: byType("concept"),
          aliases: repo.listAliases().length,
          facts: repo.listFacts().length,
          relations: repo.listRelations().length,
          abilities: repo.listAbilities().length,
          events: repo.listEvents().length,
          anchors: repo.listMemoryAnchors().length,
          appearances: entities.reduce((sum, e) => sum + repo.listAppearances(e.id).length, 0),
        },
      });
    });
    return;
  }

  if (pathname === "/api/index") {
    withRepo(dbPath, url, defaultChapter, (repo, bound) => {
      const groups: { type: string; label: string; count: number; entities: unknown[] }[] = [];
      for (const type of ["character", "organization", "location", "item", "concept"] as EntityType[]) {
        const list = repo
          .listEntities(type)
          .map((e) => {
            const aliases = repo.listAliases(e.id).map((a) => a.alias);
            const taglineFact = repo
              .listFacts(e.id)
              .find((f) => FACT_TAGLINE_TYPES.includes(f.type));
            return {
              name: e.name,
              first_seen_chapter: e.first_seen_chapter,
              last_seen_chapter: e.last_seen_chapter,
              aliases,
              tagline: taglineFact?.value ?? null,
              appearances: repo.firstAndLastAppearance(e.id),
            };
          })
          .sort((a, b) => (a.first_seen_chapter ?? 0) - (b.first_seen_chapter ?? 0));
        groups.push({ type, label: typeLabel(type), count: list.length, entities: list });
      }
      sendJson(res, 200, { userChapter: bound, groups });
    });
    return;
  }

  if (pathname === "/api/entity") {
    const name = url.searchParams.get("name") ?? "";
    if (!name) {
      sendJson(res, 400, { error: "缺少 name 参数" });
      return;
    }
    withRepo(dbPath, url, defaultChapter, (repo, bound) => {
      const viaId = repo.getEntity(name);
      const viaName = viaId ? null : repo.findEntityByName(name);
      const viaAlias = viaId || viaName ? null : repo.findByAlias(name);
      const entity = viaId ?? viaName ?? viaAlias;
      if (!entity) {
        sendJson(res, 404, { error: `在"第 ${bound} 章之前"的数据中找不到「${name}」；可能尚未出场 / 还未构建到对应章节，或换个称呼试试` });
        return;
      }
      const aliases = repo.listAliases(entity.id).map((a) => a.alias);
      const relationRows = repo.listRelations(entity.id);
      const relations = relationRows.map((r) => {
        const otherId = r.from_entity_id === entity.id ? r.to_entity_id : r.from_entity_id;
        const other = repo.getEntity(otherId);
        return {
          type: r.type,
          detail: r.detail,
          chapter: r.chapter,
          confidence: r.confidence,
          direction: r.from_entity_id === entity.id ? "out" : "in",
          other: { id: otherId, name: other?.name ?? otherId },
        };
      });
      const events = repo.listEvents(entity.id).map((e) => {
        let participants: string[] = [];
        try {
          const ids = JSON.parse(e.participants) as string[];
          participants = ids.map((id) => repo.getEntity(id)?.name ?? id);
        } catch {
          participants = [];
        }
        return { chapter: e.chapter, type: e.type, summary: e.summary, importance: e.importance, participants };
      });
      const appearances = repo.listAppearances(entity.id);
      sendJson(res, 200, {
        userChapter: bound,
        resolvedAs: viaId ? "name" : viaName ? "name" : "alias",
        entity,
        aliases,
        facts: repo.listFacts(entity.id),
        abilities: repo.listAbilities(entity.id),
        relations,
        events,
        anchors: repo.listMemoryAnchors(entity.id),
        appearances,
        appearanceStats: repo.firstAndLastAppearance(entity.id),
      });
    });
    return;
  }

  if (pathname === "/api/search") {
    const q = url.searchParams.get("q") ?? "";
    const topK = Math.min(Math.max(Number.parseInt(url.searchParams.get("topK") ?? "10", 10) || 10, 1), 30);
    if (!q.trim()) {
      sendJson(res, 400, { error: "缺少 q 参数" });
      return;
    }
    withRepo(dbPath, url, defaultChapter, (repo, bound) => {
      const hits = searchEntities(repo, q, topK);
      sendJson(res, 200, { userChapter: bound, query: q, hits });
    });
    return;
  }

  sendJson(res, 404, { error: `未知接口 ${pathname}` });
}

/** 每个请求打开一个独立的 StoryRepo 并设置阅读进度边界（数据访问层防剧透过滤）。 */
function withRepo(
  dbPath: string,
  url: URL,
  defaultChapter: number,
  fn: (repo: StoryRepo, bound: number) => void
): void {
  const repo = new StoryRepo(dbPath);
  try {
    const bound = parseChapter(url.searchParams.get("chapter") ?? undefined, defaultChapter);
    repo.setUserChapter(bound);
    fn(repo, bound);
  } finally {
    repo.close();
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "character":
      return "角色";
    case "organization":
      return "组织";
    case "location":
      return "地点";
    case "item":
      return "物品";
    case "concept":
      return "概念";
    default:
      return type;
  }
}

// ---------- 静态文件 ----------

function serveStatic(res: ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR + sep) && filePath !== join(WEB_DIR, "index.html")) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }
  if (!existsSync(filePath) || filePath === WEB_DIR) {
    // SPA 兜底：未知路径一律回 index.html（前端按 hash 路由）
    const idx = join(WEB_DIR, "index.html");
    if (existsSync(idx)) {
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      res.end(readFileSync(idx));
    } else {
      sendJson(res, 404, { error: "未找到 web/ 静态目录（请在项目根运行 story web）" });
    }
    return;
  }
  const type = MIME[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
}