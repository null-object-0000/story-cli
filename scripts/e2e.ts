// 端到端验证脚本（无 LLM API Key 也可运行，使用 mock provider）。
//
// V0.1 收口后的新理念：
//   一本小说【完整导入 + 完整构建】一次，所有读者共享同一份 Story Data；
//   Reader 的无剧透边界 = userChapter。
//
// 验证两件事同时成立：
//   Fact A：完整 DB 中确实存在 userChapter（405）之后的数据（406~420 章 + 未来人物/能力/身份/别名/锚点/事件）；
//   Fact B：Reader API（listEntities / findEntityByName / findByAlias / getEntity / search_entities / ...）
//           在 userChapter=405 时完全无法获得这些未来数据。

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildNovelText } from "./make-fixture.js";
import { StoryRepo } from "../src/db/repo.js";
import { validateExtractionOutput, ValidationError } from "../src/build/validation.js";
import { searchEntities } from "../src/ask/search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 编译后本文件在 dist/scripts/ 下，项目根在其上两级
const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "src", "cli.js");
const PROJ = join(ROOT, "test", ".e2e", "proj");
const UNIT = join(ROOT, "test", ".e2e", "unit");
const FIXTURE = join(PROJ, "我不是戏神.txt");
const DB = join(PROJ, ".story", "story.db");

const USER_CHAPTER = 405;
const TOTAL_CHAPTERS = 420;
const FUTURE_CHAPTERS = TOTAL_CHAPTERS - USER_CHAPTER; // 15 章（406~420）

interface TestCase {
  name: string;
  run: () => string; // return messages (empty = pass)
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

function exec(args: string[], cwd: string = PROJ): { code: number; stdout: string; stderr: string } {
  // 合并 stdout + stderr 以便检查
  const cmd = `"${process.execPath}" "${CLI}" ${args.map((s) => (s.includes(" ") ? `"${s}"` : s)).join(" ")}`;
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    const out = e.stdout?.toString()?.trim() ?? "";
    const err = e.stderr?.toString()?.trim() ?? "";
    return { code: e.status ?? 1, stdout: out, stderr: err };
  }
}

/** 打开 e2e 项目 DB；可选设置 Reader 边界 userChapter */
function openReader(userChapter?: number): StoryRepo {
  const repo = new StoryRepo(DB);
  if (userChapter !== undefined) repo.setUserChapter(userChapter);
  return repo;
}

/** 完整 DB 中 chapter > bound 的结构化记录数（不含 chapters 表），用于 Fact A */
function countFutureRows(d: DatabaseSync, bound: number): number {
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
    const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND ${c} > ?`).get(bound) as { n: number }).n;
    total += n;
  }
  return total;
}

function main(): number {
  console.log("\n=== story CLI V0.1 端到端验证（完整 DB + userChapter 可见性）===\n");

  // 清理 + 准备
  if (existsSync(PROJ)) rmSync(PROJ, { recursive: true });
  if (existsSync(UNIT)) rmSync(UNIT, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  mkdirSync(UNIT, { recursive: true });
  writeFileSync(FIXTURE, buildNovelText(), "utf-8");

  // ---- 1. init（不再有 --max-chapter）----
  test("init", () => {
    const r = exec(["init", "--book", "我不是戏神", "--user-chapter", String(USER_CHAPTER)]);
    assert(r.code === 0, `init 失败: ${r.stderr}`);
    assert(existsSync(join(PROJ, ".story", "config.json")), "config.json 未创建");
    assert(existsSync(DB), "story.db 未创建");
    const cfg = JSON.parse(readFileSync(join(PROJ, ".story", "config.json"), "utf-8"));
    assert(cfg.maxChapter === undefined, `config 不应再包含 maxChapter，实际: ${JSON.stringify(cfg)}`);
    assert(cfg.userChapter === USER_CHAPTER, `userChapter 应为 ${USER_CHAPTER}`);
  });

  // ---- 2. import（不再有 --to-chapter；导入整本）----
  test("import 导入整本（全部 420 章，无物理截断）", () => {
    const r = exec(["import", FIXTURE]);
    assert(r.code === 0, `import 失败: ${r.stderr}`);
    assert(r.stdout.includes("availableThrough"), `import 应报告 availableThrough: ${r.stdout.slice(0, 300)}`);
    const d = new DatabaseSync(DB);
    const cnt = (d.prepare("SELECT COUNT(*) AS n FROM chapters").get() as { n: number }).n;
    d.close();
    assert(cnt === TOTAL_CHAPTERS, `应导入全部 ${TOTAL_CHAPTERS} 章，实际 ${cnt}`);
  });

  // ---- 3. build（全部 420 章都允许构建）----
  test("build 全量构建（1~420）", () => {
    const r = exec(["build", "--provider", "mock"]);
    assert(r.code === 0, `build 失败: ${r.stderr}\n${r.stdout.slice(0, 500)}`);
    assert(r.stdout.includes("Build complete"), `build 未完成: ${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes("Characters"), `build 缺少统计: ${r.stdout.slice(0, 200)}`);
  });

  // ---- 4. review --auto ----
  test("review --auto", () => {
    const r = exec(["review", "--auto"]);
    assert(r.code === 0, `review 失败: ${r.stderr}`);
    assert(r.stdout.includes("Review 完成"), `review 未完成: ${r.stdout.slice(0, 200)}`);
  });

  // ---- 5. stats（含完整性校验，原 validate 已并入 stats）----
  test("stats 含完整性校验（无严重错误 → exit 0）", () => {
    const r = exec(["stats"]);
    assert(r.code === 0, `stats 报告严重错误: ${r.stdout.slice(0, 500)}`);
    assert(r.stdout.includes("未发现严重错误"), `stats 应含完整性结论: ${r.stdout.slice(0, 300)}`);
  });

  // ---- 6. ask 用例（userChapter=405）----
  test("ask Case 1: 闻人佑是谁来着？", () => {
    const r = exec(["ask", "闻人佑是谁来着？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("三师兄"), `应包含"三师兄"：\n${out}`);
    assert(out.includes("板车"), `应包含"板车"：\n${out}`);
    assert(out.includes("做饭"), `应包含"做饭"：\n${out}`);
    assert(out.includes("第392章"), `应包含"第392章"：\n${out}`);
    assert(!out.includes("未来外号"), `不应包含未来别名：\n${out}`);
    assert(!out.includes("419"), `不应包含未来锚点章节：\n${out}`);
  });

  test("ask Case 2: 那个给大家做饭的三师兄是谁？", () => {
    const r = exec(["ask", "那个给大家做饭的三师兄是谁？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(r.stdout.includes("闻人佑"), `应回答「闻人佑」：\n${r.stdout}`);
  });

  test("ask Case 3: 那个一直拉着戏台板车的人是谁？", () => {
    const r = exec(["ask", "那个一直拉着戏台板车的人是谁？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(r.stdout.includes("闻人佑"), `应回答「闻人佑」：\n${r.stdout}`);
  });

  test("ask Case 4: 陈伶到现在有哪些技能？（不得包含未来能力）", () => {
    const r = exec(["ask", "陈伶到现在有哪些技能？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    const expected = ["心蟒", "杀戮舞曲", "秘瞳", "无相", "审判庭", "血衣", "猩红戏法", "正义的铁拳", "通讯设备", "织命"];
    const found = expected.filter((e) => out.includes(e));
    assert(found.length >= 5, `应包含至少 5 个能力，实际匹配 ${found.length}/${expected.length}：\n${out}`);
    assert(!out.includes("未来之力"), `405 章不得看到未来能力"未来之力"：\n${out}`);
  });

  test("ask Case 5: 心蟒是谁的能力？陈伶什么时候得到的？", () => {
    const r = exec(["ask", "心蟒是谁的能力？陈伶什么时候得到的？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("心蟒"), `应包含能力名：\n${out}`);
    assert(out.includes("白也"), `应包含来源"白也"：\n${out}`);
    assert(out.includes("第170章") || out.includes("170"), `应包含获得章节：\n${out}`);
  });

  test("ask Case 6: 陈伶和闻人佑是什么关系？", () => {
    const r = exec(["ask", "陈伶和闻人佑是什么关系？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("师兄弟") || out.includes("三师兄"), `应包含关系"师兄弟"：\n${out}`);
  });

  test("ask Case 7: 闻人佑最喜欢什么颜色？", () => {
    const r = exec(["ask", "闻人佑最喜欢什么颜色？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(r.stdout.includes("不足以可靠回答"), `应回答"不足以可靠回答"：\n${r.stdout}`);
  });

  test("ask Case 8: 未来人物在 405 章不可见（不得泄露未来实体）", () => {
    const r = exec(["ask", "未来人物是谁？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(!r.stdout.includes("未来人物"), `405 章问未来人物不得泄露该实体：\n${r.stdout}`);
    assert(!r.stdout.includes("未来之力"), `405 章不得泄露未来能力：\n${r.stdout}`);
  });

  test("ask --chapter 800 能看到未来内容（临时覆盖）", () => {
    const r = exec(["ask", "未来人物是谁？", "--provider", "mock", "--chapter", "800"]);
    assert(r.code === 0, `ask --chapter 失败: ${r.stderr}`);
    assert(r.stdout.includes("未来人物"), `800 章应能看到未来人物：\n${r.stdout}`);
  });

  // ---- 7. 命令面精简验证（原 character 命令已并入 ask；validate 并入 stats；audit-spoilers 并入 audit）----
  test("已移除命令：character / validate / audit-spoilers 返回未知命令", () => {
    for (const args of [["character", "闻人佑"], ["validate"], ["audit-spoilers"]]) {
      const r = exec(args);
      assert(r.code !== 0, `${args.join(" ")} 应已移除（返回非零）：${r.stdout.slice(0, 200)}`);
    }
  });

  // ---- 8. stats ----
  test("stats", () => {
    const r = exec(["stats"]);
    assert(r.code === 0, `stats 失败: ${r.stderr}`);
    assert(r.stdout.includes("Chapters"), `stats 应包含统计：\n${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes("availableThrough = 420"), `stats 应报告 availableThrough=420：\n${r.stdout.slice(0, 300)}`);
  });

  // ---- 9. audit：Reader Visibility Audit ----
  test("audit --chapter 405（Reader 可见性审计，0 违规）", () => {
    const r = exec(["audit", "--chapter", String(USER_CHAPTER)]);
    assert(r.code === 0, `audit 应通过（0 违规）: ${r.stdout.slice(0, 600)}`);
    assert(r.stdout.includes("Reader Visibility Audit"), `应为 Reader Visibility Audit：\n${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes("Reader visibility violations: 0"), `应报告 0 违规：\n${r.stdout.slice(0, 300)}`);
    assert(r.stdout.includes("Future data present in DB"), `应报告 Fact A 未来数据存在：\n${r.stdout.slice(0, 400)}`);
  });

  // ---- 10. 断点续跑验证 ----
  test("build 断点续跑（应跳过已完成批次）", () => {
    const r = exec(["build", "--provider", "mock"]);
    assert(r.code === 0, `续跑 build 失败: ${r.stderr}`);
    assert(r.stdout.includes("跳过已完成的批次"), `应报告跳过：\n${r.stdout.slice(0, 300)}`);
  });

  test("build --force 区间重跑（--to-chapter 为本次构建任务结束章节）", () => {
    const r = exec(["build", "--from-chapter", "390", "--to-chapter", "420", "--force", "--provider", "mock"]);
    assert(r.code === 0, `force build 失败: ${r.stderr}`);
    assert(r.stdout.includes("390"), `应包含 390 区间：\n${r.stdout.slice(0, 300)}`);
  });

  // ---- 11. Fact A：完整 DB 确实存在未来数据 ----
  test("Fact A: 完整 DB 存在 406~420 章未来数据", () => {
    const d = new DatabaseSync(DB);
    const chaptersBeyond = (d.prepare("SELECT COUNT(*) AS n FROM chapters WHERE chapter > ?").get(USER_CHAPTER) as { n: number }).n;
    assert(chaptersBeyond === FUTURE_CHAPTERS, `应存在 ${FUTURE_CHAPTERS} 章未来章节，实际 ${chaptersBeyond}`);
    const futureStructured = countFutureRows(d, USER_CHAPTER);
    assert(futureStructured > 0, `406~420 应存在未来结构化数据，实际 ${futureStructured}`);
    const futureEntities = (d.prepare("SELECT COUNT(*) AS n FROM entities WHERE first_seen_chapter > ?").get(USER_CHAPTER) as { n: number }).n;
    assert(futureEntities > 0, `应存在未来实体（未来人物），实际 ${futureEntities}`);
    const futureAlias = (d.prepare("SELECT COUNT(*) AS n FROM aliases WHERE from_chapter > ?").get(USER_CHAPTER) as { n: number }).n;
    assert(futureAlias > 0, `应存在未来别名（未来外号），实际 ${futureAlias}`);
    d.close();
  });

  // ---- 12. Fact B：Reader API 在 userChapter=405 完全不可见未来数据 ----
  test("Fact B: findEntityByName/getEntity 不泄露未来实体", () => {
    const r = openReader(USER_CHAPTER);
    assert(r.findEntityByName("未来人物") === null, "findEntityByName('未来人物') 必须为 null");
    assert(r.getEntity("character_未来人物") === null, "getEntity 必须为 null");
    assert(r.findEntityByName("陈伶") !== null, "陈伶应可见");
    r.close();
    // Build 模式（无边界）能看到——证明数据确实在完整 DB 中
    const build = openReader();
    assert(build.findEntityByName("未来人物") !== null, "Build 模式应能看到未来人物（完整 DB）");
    build.close();
  });

  test("Fact B: findByAlias 不泄露未来别名", () => {
    const r = openReader(USER_CHAPTER);
    assert(r.findByAlias("未来外号") === null, "findByAlias('未来外号') 必须为 null（alias.from_chapter=418 > 405）");
    assert(r.findByAlias("未来代号") === null, "findByAlias('未来代号') 必须为 null（未来人物的别名）");
    assert(r.findByAlias("三师兄") !== null, "既有别名 三师兄 应可见");
    r.close();
    const build = openReader();
    assert(build.findByAlias("未来外号")?.name === "闻人佑", "Build 模式应能解析未来别名 → 闻人佑");
    build.close();
  });

  test("Fact B: search_entities / listEntities 不泄露未来实体", () => {
    const r = openReader(USER_CHAPTER);
    const hitF = searchEntities(r, "未来人物", 10);
    assert(!hitF.some((h) => h.entity.name === "未来人物"), "search_entities('未来人物') 不得命中未来人物");
    const hitA = searchEntities(r, "未来代号", 10);
    assert(!hitA.some((h) => h.entity.name === "未来人物"), "search_entities('未来代号') 不得命中未来人物");
    const names = r.listEntities().map((e) => e.name);
    assert(!names.includes("未来人物"), "listEntities 不得包含未来人物");
    r.close();
  });

  test("Fact B: Fact 状态（身份）按 userChapter 过滤", () => {
    const r405 = openReader(USER_CHAPTER);
    const chen405 = r405.findEntityByName("陈伶")!;
    const values405 = r405.listFacts(chen405.id).map((f) => f.value);
    assert(values405.includes("戏道古藏修行弟子"), "405 应看到 392 章身份");
    assert(!values405.includes("未来首领"), "405 不得看到 415 章未来首领身份");
    r405.close();
    const r600 = openReader(600);
    const chen600 = r600.findEntityByName("陈伶")!;
    const values600 = r600.listFacts(chen600.id).map((f) => f.value);
    assert(values600.includes("未来首领"), "600 应看到未来首领身份");
    r600.close();
  });

  test("Fact B: abilities / events / anchors 按 userChapter 过滤", () => {
    const r405 = openReader(USER_CHAPTER);
    const chen = r405.findEntityByName("陈伶")!;
    assert(!r405.listAbilities(chen.id).some((a) => a.name === "未来之力"), "405 不得看到未来之力");
    assert(r405.listAbilities(chen.id).some((a) => a.name === "织命"), "405 应看到 300 章能力织命");
    const wen = r405.findEntityByName("闻人佑")!;
    assert(!r405.listMemoryAnchors(wen.id).some((m) => m.chapter === 419), "405 不得看到 419 章未来锚点");
    assert(!r405.listEvents().some((e) => e.chapter === 420), "405 不得看到 420 章未来事件");
    assert(!r405.listRelations(wen.id).some((rel) => rel.chapter > USER_CHAPTER), "405 不得看到未来关系");
    r405.close();
  });

  test("Fact B: 闻人佑 lastSeen <= 405（character 命令的最近出现不泄露未来）", () => {
    const r = openReader(USER_CHAPTER);
    const wen = r.findEntityByName("闻人佑")!;
    const { last, first } = r.firstAndLastAppearance(wen.id);
    assert(first === 392, `首次出现应为 392，实际 ${first}`);
    assert(last !== null && last <= USER_CHAPTER, `最近出现必须 <= 405，实际 ${last}`);
    r.close();
    const r800 = openReader(800);
    const wen800 = r800.findEntityByName("闻人佑")!;
    const last800 = r800.firstAndLastAppearance(wen800.id).last;
    assert(last800 === TOTAL_CHAPTERS, `800 章应看到最近出现 = 420，实际 ${last800}`);
    r800.close();
  });

  test("Fact B: get_entity_index 不泄露未来实体", () => {
    const r = openReader(USER_CHAPTER);
    const digest = JSON.stringify(r.listEntities().map((e) => e.name));
    assert(!digest.includes("未来人物"), "entity index 不得包含未来人物");
    r.close();
  });

  // ---- 13. 多章节视角：同一 Reader 查询单调增长 + 降低 userChapter 后未来信息消失 ----
  test("多章节视角回归：可见实体数随 userChapter 单调增长", () => {
    const counts: number[] = [];
    for (const uc of [100, 300, USER_CHAPTER, 800]) {
      const r = openReader(uc);
      counts.push(r.listEntities().length);
      assert(r.findEntityByName("未来人物") === null || uc >= 410, `未来人物在 ${uc} 章必须不可见`);
      r.close();
    }
    assert(counts[0] <= counts[1] && counts[1] <= counts[2] && counts[2] <= counts[3], `可见实体数应单调增长，实际 ${counts.join(" -> ")}`);
  });

  test("降低 userChapter 后未来信息必须消失（同一 repo 实例）", () => {
    const r = openReader(800);
    assert(r.findEntityByName("未来人物") !== null, "800 章应能看到未来人物");
    const chen = r.findEntityByName("陈伶")!;
    assert(r.listFacts(chen.id).map((f) => f.value).includes("未来首领"), "800 章应看到未来首领");
    assert(r.listAbilities(chen.id).some((a) => a.name === "未来之力"), "800 章应看到未来之力");
    // 降回 405
    r.setUserChapter(USER_CHAPTER);
    assert(r.findEntityByName("未来人物") === null, "降到 405 后未来人物必须消失");
    assert(!r.listFacts(chen.id).map((f) => f.value).includes("未来首领"), "降到 405 后未来首领必须消失");
    assert(!r.listAbilities(chen.id).some((a) => a.name === "未来之力"), "降到 405 后未来之力必须消失");
    r.close();
  });

  // ---- 14. Extraction Batch Range Validation ----
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

  // ---- 15. same-name-different-type 冲突检测 ----
  test("same-name-different-type → possible_duplicates(type_conflict)", () => {
    const unit = new StoryRepo(join(UNIT, "conflict.db"));
    unit.upsertEntity("concept", "梅花K测试体", 100);
    unit.upsertEntity("character", "梅花K测试体", 105);
    const tc = unit.listPossibleDuplicates().find((d) => (d.reason ?? "").includes("type_conflict"));
    assert(tc !== undefined, "应自动生成 type_conflict 疑似重复");
    unit.close();
  });

  // ---- 16. entityName canonicalization 契约 ----
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

  // ---- 17. 静态检查：Ask/Agent/TUI 模块绝不触碰 chapters 原文表 ----
  test("Ask 模块不读取原文", () => {
    const dirs: { dir: string; files: string[] }[] = [
      { dir: join(ROOT, "src", "ask"), files: ["answer.ts", "context.ts", "intent.ts", "recall.ts", "search.ts"] },
      { dir: join(ROOT, "src", "agent"), files: readdirSync(join(ROOT, "src", "agent")).filter((f) => f.endsWith(".ts")) },
      { dir: join(ROOT, "src", "tui"), files: readdirSync(join(ROOT, "src", "tui")).filter((f) => f.endsWith(".ts")) },
    ];
    for (const { dir, files } of dirs) {
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf-8");
        for (const forbidden of ["getChapterText", "replaceChapters", "FROM chapters", "select * from chapters"]) {
          if (content.includes(forbidden)) {
            throw new Error(`${dir}/${f} 疑似触碰 chapters 原文：包含「${forbidden}」`);
          }
        }
        if (/from\s+["']\.\.\/novel/.test(content)) {
          throw new Error(`${dir}/${f} 引用了 novel 模块（原文路径）`);
        }
        if (/from\s+["']\.\.\/build/.test(content)) {
          throw new Error(`${dir}/${f} 引用了 build 模块（原文路径）。仅 src/agent/ops.ts 允许。`);
        }
      }
    }
  });

  // ---- 总结 ----
  const total = passed + failed;
  console.log(`\n结果：${passed}/${total} 通过，${failed} 失败`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();
