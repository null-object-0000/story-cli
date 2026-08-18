// story audit / story audit-spoilers：Reader Visibility Audit（读者可见性审计）
//
// V0.1 收口后的新语义：
//   旧审计检查“数据库里有没有 chapter > maxChapter 的记录”——这已无意义，因为完整 Story DB
//   本来就该包含未来章节。新审计验证的是：当 Reader（Ask/Agent/TUI/character）以 userChapter 为边界时，
//   通过【Reader 公开 API】是否可能返回 chapter / first_seen_chapter / from_chapter > userChapter 的数据。
//
// 同时验证两个事实同时成立：
//   Fact A：完整 DB 中确实存在 userChapter 之后的数据（证明审计对象真实存在）；
//   Fact B：Reader API 在 userChapter 边界下完全无法获得这些数据。
//     - Reader API 的返回结果本身不得包含超出 userChapter 的记录；
//     - 全库中 first_seen > userChapter 的实体，必须无法通过 getEntity / findEntityByName / findByAlias 发现
//       （“未来人物的存在本身”也是剧透）。
//
// 用法：story audit [--chapter N]（缺省 N = config.userChapter）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo, EntityRow, AliasRow, FactRow, RelationRow, AbilityRow, EventRow, MemoryAnchorRow } from "../db/repo.js";
import { searchEntities } from "../ask/search.js";
import { log, warn, section } from "../logger.js";

interface Violation {
  api: string;
  kind: string;
  chapter: number;
  detail: string;
}

interface AuditRow {
  label: string;
  checked: number;
  violations: number;
}

export async function cmdAuditSpoilers(flags: Record<string, string | boolean> = {}): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath());
  try {
    const userChapter = parseChapterFlag(flags) ?? cfg.userChapter;
    const availableThrough = repo.availableThrough() ?? 0;
    const builtThrough = repo.builtThrough();
    const violations: Violation[] = [];
    const rows: AuditRow[] = [];

    // ── Fact A：完整 DB 中确实存在 userChapter 之后的数据（结构化+章节） ──
    const futureStructured = countFutureRows(repo, userChapter);
    const futureChapters = availableThrough > userChapter ? availableThrough - userChapter : 0;

    // 以 Build 模式（无过滤）枚举全库实体/别名，作为“不可发现”检查的输入
    const allEntities = repo.listEntities();
    const allAliases = repo.listAliases();
    const entityById = new Map(allEntities.map((e) => [e.id, e]));

    // ── Fact B：切换到 Reader 边界，逐一验证 Reader 公开 API ──
    repo.setUserChapter(userChapter);

    // 1) Reader API 的【返回结果】不得包含超出 userChapter 的记录
    const checkReturned = <T>(
      label: string,
      records: T[],
      getChapter: (r: T) => number | null,
      getDetail: (r: T) => string,
      api: string
    ): void => {
      let n = 0;
      for (const r of records) {
        const ch = getChapter(r);
        if (ch !== null && ch > userChapter) {
          n++;
          violations.push({ api, kind: "future", chapter: ch, detail: getDetail(r) });
        }
      }
      rows.push({ label, checked: records.length, violations: n });
    };

    checkReturned("Entities", repo.listEntities(), (e: EntityRow) => e.first_seen_chapter, (e) => `${e.name}（firstSeen=${e.first_seen_chapter}）`, "listEntities");
    checkReturned("Aliases", repo.listAliases(), (a: AliasRow) => a.from_chapter, (a) => `${a.alias}（from=${a.from_chapter}）`, "listAliases");
    checkReturned("Facts", repo.listFacts(), (f: FactRow) => f.chapter, (f) => `${f.entity_id}: ${f.value.slice(0, 30)}（第${f.chapter}章）`, "listFacts");
    checkReturned("Relations", repo.listRelations(), (r: RelationRow) => r.chapter, (r) => `${r.from_entity_id}-${r.to_entity_id} ${r.type}（第${r.chapter}章）`, "listRelations/get_relations");
    checkReturned("Abilities", repo.listAbilities(), (a: AbilityRow) => a.chapter, (a) => `${a.entity_id}: ${a.name}（第${a.chapter}章）`, "listAbilities");
    checkReturned("Events", repo.listEvents(), (e: EventRow) => e.chapter, (e) => `${e.summary.slice(0, 30)}（第${e.chapter}章）`, "listEvents");
    checkReturned("Memory Anchors", repo.listMemoryAnchors(), (m: MemoryAnchorRow) => m.chapter, (m) => `${m.entity_id}: ${m.summary.slice(0, 30)}（第${m.chapter}章）`, "listMemoryAnchors");

    // Appearances：对可见实体查出场记录
    {
      let checked = 0;
      let n = 0;
      for (const e of repo.listEntities()) {
        const apps = repo.listAppearances(e.id);
        checked += apps.length;
        for (const a of apps) {
          if (a.chapter > userChapter) {
            n++;
            violations.push({ api: "listAppearances", kind: "future", chapter: a.chapter, detail: `${e.name} 第${a.chapter}章出场` });
          }
        }
      }
      rows.push({ label: "Appearances", checked, violations: n });
    }

    // 2) 未来实体不可发现：全库中 first_seen > userChapter 的实体，getEntity/findEntityByName 必须为 null
    {
      let checked = 0;
      let n = 0;
      for (const e of allEntities) {
        if (e.first_seen_chapter <= userChapter) continue;
        checked++;
        const byId = repo.getEntity(e.id);
        const byName = repo.findEntityByName(e.name);
        if (byId !== null || byName !== null) {
          n++;
          violations.push({ api: "getEntity/findEntityByName", kind: "future", chapter: e.first_seen_chapter, detail: `未来实体 ${e.name}（firstSeen=${e.first_seen_chapter}）仍可被发现` });
        }
      }
      rows.push({ label: "Entity Lookup", checked, violations: n });
    }

    // 3) 未来别名不可发现：from_chapter > userChapter（或所属实体 first_seen > userChapter）的别名，findByAlias 必须为 null
    {
      let checked = 0;
      let n = 0;
      for (const a of allAliases) {
        const entity = entityById.get(a.entity_id);
        const future = a.from_chapter > userChapter || (entity !== undefined && entity.first_seen_chapter > userChapter);
        if (!future) continue;
        checked++;
        const hit = repo.findByAlias(a.alias);
        if (hit !== null) {
          n++;
          violations.push({ api: "findByAlias", kind: "future", chapter: a.from_chapter, detail: `未来别名「${a.alias}」（from=${a.from_chapter}）仍可解析到 ${hit.name}` });
        }
      }
      rows.push({ label: "Alias Lookup", checked, violations: n });
    }

    // 4) Reader Search（search_entities / get_entity）：用每个可见名称/别名查询，返回实体不得超出边界
    {
      const visibleNames = [...new Set([...repo.listEntities().map((e) => e.name), ...repo.listAliases().map((a) => a.alias)])];
      let checked = 0;
      let n = 0;
      for (const name of visibleNames) {
        checked++;
        for (const h of searchEntities(repo, name, 10)) {
          if (h.entity.first_seen_chapter > userChapter) {
            n++;
            violations.push({ api: "search_entities", kind: "future", chapter: h.entity.first_seen_chapter, detail: `「${name}」→ 命中未来实体 ${h.entity.name}` });
          }
        }
      }
      rows.push({ label: "Reader Search", checked, violations: n });
    }

    // 5) Chapter 目录（list_chapters）：只应返回 <= userChapter 的章节元信息
    {
      const chapters = repo.listChapterMeta();
      let n = 0;
      for (const c of chapters) if (c.chapter > userChapter) { n++; violations.push({ api: "list_chapters", kind: "future", chapter: c.chapter, detail: `第${c.chapter}章` }); }
      rows.push({ label: "Chapters", checked: chapters.length, violations: n });
    }

    const futureEntityLeaks = violations.filter((v) => /未来实体|命中未来实体/.test(v.detail)).length;

    section("Reader Visibility Audit");
    log(`Book            : ${cfg.book}`);
    log(`Available through : ${availableThrough}`);
    log(`Built through    : ${builtThrough ?? 0}`);
    log(`User chapter     : ${userChapter}`);
    log(`Effective through: ${builtThrough === null || builtThrough > userChapter ? userChapter : builtThrough}`);
    log("");
    log("Checking:");
    log("");
    for (const r of rows) {
      log(`  ${r.label.padEnd(18)} ${r.violations === 0 ? "PASS" : "FAIL"}   (checked ${r.checked})`);
    }
    log("");
    log(`Future data present in DB (Fact A): ${futureStructured} structured rows + ${futureChapters} chapters beyond ch.${userChapter}`);
    log(`Future entity leaks  : ${futureEntityLeaks}`);
    log(`Future chapter leaks : ${violations.length - futureEntityLeaks}`);
    log(`Reader visibility violations: ${violations.length}`);
    log("");
    if (violations.length === 0) {
      log("Reader 在 userChapter 边界下看不到任何超出阅读进度的数据 ✔");
      return 0;
    }
    for (const v of violations.slice(0, 50)) {
      warn(`  [${v.api}] ${v.kind}: ${v.detail}`);
    }
    if (violations.length > 50) warn(`  ... 还有 ${violations.length - 50} 条`);
    return 1;
  } finally {
    repo.close();
  }
}

/** Fact A：完整 DB 中 chapter > userChapter 的结构化记录数（不含 chapters 表） */
function countFutureRows(repo: StoryRepo, userChapter: number): number {
  let total = 0;
  const tables: [string, string][] = [
    ["entities", "first_seen_chapter"],
    ["entities", "last_seen_chapter"],
    ["aliases", "from_chapter"],
    ["facts", "chapter"],
    ["relations", "chapter"],
    ["abilities", "chapter"],
    ["abilities", "acquired_chapter"],
    ["events", "chapter"],
    ["memory_anchors", "chapter"],
    ["entity_appearances", "chapter"],
  ];
  for (const [t, c] of tables) {
    const n = (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND ${c} > ?`).get(userChapter) as { n: number }).n;
    total += n;
  }
  return total;
}

function parseChapterFlag(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--chapter 必须是正整数：${v}`);
  return n;
}
