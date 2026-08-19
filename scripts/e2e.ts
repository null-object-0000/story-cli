// 端到端验证（纯 Node 分支，无需 LLM / API Key）：
//   - Extraction 校验（Batch Range 等）
//   - DB 层不变式（same-name-different-type → type_conflict、entityName canonicalization）
//   - Reader/TUI 模块原文隔离静态检查
//
// 完整 init→import→build→ask→audit 流程需要真实 LLM，由实际使用验证（mock 已移除）。

import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { StoryRepo } from "../src/db/repo.js";
import { validateExtractionOutput, ValidationError, MEMORY_ANCHOR_KINDS } from "../src/build/validation.js";
import { searchEntities } from "../src/reader/search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 编译后本文件在 dist/scripts/ 下，项目根在其上两级
const ROOT = join(__dirname, "..", "..");
const UNIT = join(ROOT, "test", ".e2e", "unit");

interface TestCase {
  name: string;
  run: () => void;
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✘ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): number {
  console.log("\n=== story 端到端验证（纯 Node 分支，无需 LLM）===\n");

  if (existsSync(UNIT)) rmSync(UNIT, { recursive: true });
  mkdirSync(UNIT, { recursive: true });

  // ---- Extraction Batch Range Validation ----
  test("Extraction Batch Validation：本批范围外的 chapter 必须失败", () => {
    // 批 100~110 内通过
    const ok = validateExtractionOutput(
      { newEntities: [], aliases: [], facts: [{ entityName: "X", type: "role", value: "v", chapter: 105, confidence: 0.9 }], relations: [], abilities: [], events: [], memoryAnchors: [], possibleDuplicates: [], conflicts: [], batchSummary: null },
      100,
      110
    );
    assert(ok.facts.length === 1, "批内 chapter=105 应通过");
    // 即使第 120 章确实存在（availableThrough >= 120），本批 100~110 也不能接受 chapter=120
    let rejected = false;
    try {
      validateExtractionOutput(
        { newEntities: [], aliases: [], facts: [{ entityName: "X", type: "role", value: "v", chapter: 120, confidence: 0.9 }], relations: [], abilities: [], events: [], memoryAnchors: [], possibleDuplicates: [], conflicts: [], batchSummary: null },
        100,
        110
      );
    } catch (e) {
      rejected = e instanceof ValidationError;
    }
    assert(rejected, "chapter=120 对批 100~110 必须校验失败");
  });

  // ---- same-name-different-type 冲突检测 ----
  test("same-name-different-type → possible_duplicates(type_conflict)", () => {
    const unit = new StoryRepo(join(UNIT, "conflict.db"));
    unit.upsertEntity("concept", "梅花K测试体", 100);
    unit.upsertEntity("character", "梅花K测试体", 105);
    const tc = unit.listPossibleDuplicates().find((d) => (d.reason ?? "").includes("type_conflict"));
    assert(tc !== undefined, "应自动生成 type_conflict 疑似重复");
    unit.close();
  });

  // ---- entityName canonicalization 契约 ----
  test("entityName canonicalization：别名解析到 canonical name，不新建实体", () => {
    const unit = new StoryRepo(join(UNIT, "canonical.db"));
    unit.upsertEntity("character", "陈伶", 1);
    unit.addAlias("character_陈伶", "红心6", 60);
    // search_existing_entities 的解析路径：name 或 alias → canonical entity
    const resolved = unit.findEntityByName("红心6") ?? unit.findByAlias("红心6");
    assert(resolved !== null && resolved.name === "陈伶", "别名「红心6」应解析到 canonical name「陈伶」");
    // 契约要求：extraction 输出必须使用 canonical name（entityName=陈伶）
    const chenId = unit.findEntityByName("陈伶")!.id;
    unit.addFact(chenId, "role", "契约测试身份", 100, 0.9);
    assert(unit.findEntityByName("红心6") === null, "「红心6」仍是别名，不应成为独立实体名");
    assert(unit.listAliases(chenId).some((a) => a.alias === "红心6"), "别名「红心6」应挂在陈伶名下");
    unit.close();
  });

  // ---- 静态检查：Reader/TUI 模块绝不触碰 chapters 原文表 ----
  test("Reader/TUI 模块不读取原文", () => {
    const dirs: { dir: string; files: string[] }[] = [
      { dir: join(ROOT, "src", "reader"), files: readdirSync(join(ROOT, "src", "reader")).filter((f) => f.endsWith(".ts")) },
      { dir: join(ROOT, "src", "cli", "tui"), files: readdirSync(join(ROOT, "src", "cli", "tui")).filter((f) => f.endsWith(".ts")) },
    ];
    for (const { dir, files } of dirs) {
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf-8");
        for (const forbidden of ["getChapterText", "replaceChapters", "FROM chapters", "select * from chapters"]) {
          if (content.includes(forbidden)) {
            throw new Error(`${dir}/${f} 疑似触碰 chapters 原文：包含「${forbidden}」`);
          }
        }
        if (/from\s+["'](?:\.\.\/)+(build|novel)\//.test(content)) {
          throw new Error(`${dir}/${f} 引用了 build/novel 模块（原文路径）`);
        }
      }
    }
  });

  // ---- MemoryAnchor kind：合法枚举通过、非法枚举拒绝、缺省为 null ----
  test("MemoryAnchor kind 校验：合法通过 / 非法拒绝 / 缺省为 null", () => {
    const base = {
      newEntities: [], aliases: [], facts: [], relations: [], abilities: [], events: [],
      possibleDuplicates: [], conflicts: [], batchSummary: null,
    };
    const ok = validateExtractionOutput(
      { ...base, memoryAnchors: [
        { entityName: "张三", chapter: 10, kind: "visual", summary: "戴着红围巾", importance: 0.3, memorability: 0.9 },
        { entityName: "张三", chapter: 11, kind: "role", summary: "负责做饭" },
        { entityName: "张三", chapter: 12, summary: "缺省 kind 的锚点", kind: undefined },
      ] },
      1, 20
    );
    assert(ok.memoryAnchors.length === 3, "3 条锚点都应通过校验");
    assert(ok.memoryAnchors[0].kind === "visual", "kind=visual 应保留");
    assert(ok.memoryAnchors[1].kind === "role", "kind=role 应保留");
    assert(ok.memoryAnchors[2].kind === null, "缺省 kind 应为 null（兼容旧输出）");
    let rejected = false;
    try {
      validateExtractionOutput(
        { ...base, memoryAnchors: [{ entityName: "张三", chapter: 10, kind: "junk", summary: "非法 kind" }] },
        1, 20
      );
    } catch (e) {
      rejected = e instanceof ValidationError && /kind 非法/.test((e as Error).message);
    }
    assert(rejected, "kind=junk 必须校验失败");
    assert(MEMORY_ANCHOR_KINDS.size === 6, "kind 枚举应为 6 种");
  });

  // ---- MemoryAnchor kind 持久化 + userChapter 可见性过滤 ----
  test("MemoryAnchor kind 持久化，且受 userChapter 过滤", () => {
    const unit = new StoryRepo(join(UNIT, "anchor-kind.db"));
    unit.upsertEntity("character", "张三", 1);
    unit.addMemoryAnchor("character_张三", 10, "戴着红围巾的高个男人", 0.3, 0.9, 0.5, "visual");
    unit.addMemoryAnchor("character_张三", 30, "队伍里一直负责做饭", 0.3, 0.9, 0.5, "role");
    const all = unit.listMemoryAnchors("character_张三");
    assert(all.length === 2, "两条锚点都应入库");
    assert(all.every((a) => a.kind !== undefined), "kind 列必须存在");
    assert(all.find((a) => a.summary.includes("红围巾"))?.kind === "visual", "visual kind 应持久化");
    // Reader 边界：chapter=20 只能看到第 10 章那条
    unit.setUserChapter(20);
    const visible = unit.listMemoryAnchors("character_张三");
    assert(visible.length === 1 && visible[0].chapter === 10, "userChapter=20 时只能看到 chapter<=20 的锚点");
    unit.close();
  });

  // ---- Character Recall：MemoryAnchor 必须真正参与人物召回（合成张三） ----
  test("Character Recall：靠 MemoryAnchor 定位「张三」（不依赖 name/alias）", () => {
    const unit = new StoryRepo(join(UNIT, "recall.db"));
    unit.upsertEntity("character", "张三", 1);
    unit.upsertEntity("character", "李四", 1);
    // 张三：只有记忆锚点，无身份/性格事实、无 alias
    unit.addMemoryAnchor("character_张三", 10, "戴着红围巾的高个男人", 0.3, 0.9, 0.5, "visual");
    unit.addMemoryAnchor("character_张三", 11, "队伍里一直负责做饭", 0.3, 0.9, 0.5, "role");
    unit.addMemoryAnchor("character_张三", 12, "每次出门都背着黑色木箱", 0.3, 0.9, 0.5, "behavior");
    // 李四：有易混淆的"不会说话"性格事实（对照组，不应被"做饭/红围巾/黑木箱"带偏）
    unit.addFact("character_李四", "personality", "不会说话", 5, 0.9);
    unit.setUserChapter(100);

    const cases: [string, string][] = [
      ["红围巾", "戴着红围巾的高个男人"],
      ["做饭的人", "队伍里一直负责做饭"],
      ["背黑色木箱的人", "每次出门都背着黑色木箱"],
    ];
    for (const [q, expectAnchor] of cases) {
      const hits = searchEntities(unit, q, 5);
      assert(hits.length > 0, `「${q}」应有命中`);
      const top = hits[0];
      assert(top.entity.name === "张三", `「${q}」第一名应为张三，实际 ${top.entity.name}`);
      assert(top.matchedVia.includes("记忆线索"), `「${q}」matchedVia 应说明记忆线索来源，实际 ${top.matchedVia}`);
      assert(top.matchedVia.includes(expectAnchor.slice(0, 8)), `「${q}」matchedVia 应引用具体锚点，实际 ${top.matchedVia}`);
      // 关键断言：命中不依赖 name/alias（查询串里不含"张三"，matchedVia 是记忆线索）
      assert(!q.includes("张三"), "查询串不应包含实体名");
    }
    // 李四不能被"做饭/红围巾"错误带偏
    for (const q of ["红围巾", "做饭的人", "背黑色木箱的人"]) {
      const hits = searchEntities(unit, q, 5);
      assert(hits[0].entity.name === "张三", `「${q}」第一名必须仍为张三（李四不得反超）`);
    }
    unit.close();
  });

  // ---- MemoryAnchor schema 迁移：旧库无 kind 列 → 打开后自动补列 ----
  test("MemoryAnchor 旧库迁移：自动补 kind 列", () => {
    const dbFile = join(UNIT, "legacy-anchor.db");
    if (existsSync(dbFile)) rmSync(dbFile, { force: true });
    // 用原始 sqlite 建一个"旧形状"的 memory_anchors 表（无 kind 列）
    const raw = new DatabaseSync(dbFile);
    raw.exec(`CREATE TABLE IF NOT EXISTS memory_anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id TEXT NOT NULL,
      chapter INTEGER NOT NULL CHECK (chapter >= 1),
      summary TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      memorability REAL NOT NULL DEFAULT 0.7,
      protagonist_relevance REAL NOT NULL DEFAULT 0.5,
      status TEXT NOT NULL DEFAULT 'active',
      UNIQUE(entity_id, chapter, summary)
    )`);
    raw.close();
    const repo = new StoryRepo(dbFile);
    const cols = (repo.db.prepare("PRAGMA table_info(memory_anchors)").all() as { name: string }[]).map((c) => c.name);
    assert(cols.includes("kind"), "旧库打开后应自动补上 kind 列");
    // 迁移后插入带 kind 的锚点仍可正常写入
    repo.upsertEntity("character", "张三", 1);
    assert(repo.addMemoryAnchor("character_张三", 5, "迁移后写入", 0.5, 0.8, 0.5, "behavior"), "迁移后 addMemoryAnchor(kind) 应成功");
    const row = repo.listMemoryAnchors("character_张三")[0];
    assert(row?.kind === "behavior", "迁移后写入的 kind 应可读回");
    repo.close();
  });

  // ---- 总结 ----
  const total = passed + failed;
  console.log(`\n结果：${passed}/${total} 通过，${failed} 失败`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();
