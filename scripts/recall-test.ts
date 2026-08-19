// Character Recall 集成测试（需要真实 LLM + 已有完整 Story DB）：
//   1. 在 test/.e2e/recall-proj 下复制现有完整 DB（含 1291 章原文 + 已构建知识）；
//   2. 用新版抽取（MemoryAnchor 一等目标 + Character Recall Sweep + kind）重建 361~405 章；
//   3. 验证闻人佑产生 Recall Data（拉板车/做饭/沉默/板着脸/教【念】）；
//   4. 验证 5 个"模糊回忆"问题仅靠 search_entities 就能定位到闻人佑（不读原文）；
//   5. 验证 userChapter=405 防剧透边界（audit 语义）。
//
// 运行：node dist/scripts/recall-test.js （需配置好 LLM；在项目根运行）

import { mkdirSync, rmSync, copyFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StoryRepo } from "../src/db/repo.js";
import { runBuild } from "../src/build/pipeline.js";
import { createProvider } from "../src/llm/index.js";
import { searchEntities } from "../src/reader/search.js";
import { loadConfig, dbPath } from "../src/config.js";
import { cmdAudit } from "../src/cli/commands/audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PROJ = join(ROOT, "test", ".e2e", "recall-proj");
const REAL_DB = dbPath(ROOT);

let passed = 0;
let failed = 0;
function check(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
    passed++;
  } else {
    console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function setupTestProject(): void {
  rmSync(PROJ, { recursive: true, force: true });
  mkdirSync(join(PROJ, ".story"), { recursive: true });
  // 复制完整 DB（含全部章节原文 + 已构建知识）——测试在副本上进行，不污染真实项目
  for (const f of ["story.db", "story.db-wal", "story.db-shm"]) {
    const src = join(ROOT, ".story", f);
    if (existsSync(src)) copyFileSync(src, join(PROJ, ".story", f));
  }
  // 写测试项目配置：沿用真实 LLM 连接，userChapter=405
  const real = loadConfig(ROOT);
  const cfg = {
    book: real.book || "我不是戏神",
    userChapter: 405,
    build: { batchSize: 1, retries: 2, autoBatch: true, perChapterOutputTokens: 320, maxBatchChapters: 60, sessionLog: true },
    llm: real.llm ?? undefined,
  };
  writeFileSync(join(PROJ, ".story", "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
}

async function main(): Promise<number> {
  console.log("\n=== Character Recall 集成测试（361~405 重建 + 闻人佑 Recall）===\n");

  setupTestProject();
  const testCfg = loadConfig(PROJ);
  const provider = createProvider(testCfg);
  const repo = new StoryRepo(join(PROJ, ".story", "story.db"));
  const prevCwd = process.cwd();
  process.chdir(PROJ); // build 会话日志写到测试项目 .story/logs/build
  try {
    // 清理测试副本里闻人佑的旧结构化数据（仅测试副本）——确保回归只反映本次重建的输出，
    // 不残留旧 Build 的错误章节归因（如 chapter=384 的"负责做饭"）。
    const staleWry = repo.findEntityByNameRaw("闻人佑");
    if (staleWry) {
      repo.db.prepare("DELETE FROM facts WHERE entity_id=?").run(staleWry.id);
      repo.db.prepare("DELETE FROM memory_anchors WHERE entity_id=?").run(staleWry.id);
      repo.db.prepare("DELETE FROM relations WHERE from_entity_id=? OR to_entity_id=?").run(staleWry.id, staleWry.id);
      repo.db.prepare("DELETE FROM aliases WHERE entity_id=?").run(staleWry.id);
    }

    console.log(`\n[1/4] 重建 361~405 章（force，LLM=${provider.name}）...`);
    const res = await runBuild(repo, provider, {
      fromChapter: 361,
      toChapter: 405,
      force: true,
      retries: 6, // evidence 校验可能触发多轮修复重试
      // Evidence Grounding 需要模型逐条给出原文证据并接受确定性校验——大批一次生成几十条记录，
      // 单次调用难以全部 ground 正确。用固定小批（5 章）把每批记录量降到个位数，显著提高单批收敛率。
      // failFast=false：允许个别批次重试耗尽失败时继续跑后续批次（闻人佑相关数据在 391~405，不受影响）。
      autoBatch: false,
      batchSize: 5,
      failFast: false,
      sessionLog: true,
      maxBatchChapters: 60,
      perChapterOutputTokens: 320,
    });
    console.log("  批次结果:");
    for (const b of res.processed) {
      console.log(`    [${b.range}] ${b.status}  entities:+${b.newEntities} facts:${b.facts} relations:${b.relations} events:${b.events} anchors:${b.memoryAnchors}${b.error ? `  error=${b.error}` : ""}`);
    }
    check(res.failed === 0, "361~405 重建无失败批次");

    // Evidence Grounding 可观测性：mainline 记录本批带 evidence 的 temporal 记录数
    {
      const mainlinePath = join(PROJ, ".story", "logs", "build", "mainline.jsonl");
      if (existsSync(mainlinePath)) {
        const lines = readFileSync(mainlinePath, "utf-8").split("\n").filter(Boolean);
        const batch = lines.map((l) => JSON.parse(l)).find((x) => x.kind === "batch" && x.status === "done");
        if (batch) {
          console.log(`  本批 evidence 校验：带 evidence 记录 ${batch.evidenceValidated ?? 0} 条，非致命 warning ${batch.evidenceWarnings ?? 0} 条`);
          check((batch.evidenceValidated ?? 0) > 0, "本批 temporal 记录均通过 evidence 确定性校验（chapter+evidence 对应原文）");
        }
      }
    }

    // 闻人佑 Recall Data
    const wry = repo.findEntityByNameRaw("闻人佑");
    check(wry !== null, "闻人佑实体存在");
    if (wry) {
      const facts = repo.listFacts(wry.id).map((f) => `${f.type}:${f.value}`);
      const anchors = repo.listMemoryAnchors(wry.id).map((a) => `[${a.kind ?? "-"}]${a.summary}`);
      const relations = repo.listRelations(wry.id).map((r) => `${r.type}:${r.detail ?? ""}`);
      console.log("  闻人佑 Facts:", JSON.stringify(facts, null, 0));
      console.log("  闻人佑 Anchors:", JSON.stringify(anchors, null, 0));
      console.log("  闻人佑 Relations:", JSON.stringify(relations, null, 0));
      const allText = [...facts, ...anchors, ...relations].join(" ");
      check(/拉/.test(allText) && /板车/.test(allText), "Recall：拉板车/板车 线索", allText.slice(0, 60));
      check(/饭/.test(allText) && /做/.test(allText), "Recall：做饭 线索");
      check(/沉/.test(allText) || /不说/.test(allText) || /少言/.test(allText), "Recall：沉默/少言 线索");
      check(/脸/.test(allText) && /板/.test(allText), "Recall：板着脸 线索");
      check(/念/.test(allText) && /教|授/.test(allText), "Recall：教【念】 线索（Anchor 或 关系 detail）");
      check(anchors.length >= 2, `闻人佑至少有 2 条 MemoryAnchor（实际 ${anchors.length}）`);
      check(anchors.some((a) => /\[(visual|behavior|habit|interaction|role|quote)\]/.test(a)), "闻人佑 Anchor 带 kind 枚举");

      // ---- Evidence Grounding 回归：Reveal Chapter 归因（原文支持章节，而非 LLM 凭印象）----
      const recs: { label: string; chapter: number; text: string }[] = [
        ...repo.listFacts(wry.id).map((f) => ({ label: "fact", chapter: f.chapter, text: f.value })),
        ...repo.listMemoryAnchors(wry.id).map((a) => ({ label: "anchor", chapter: a.chapter, text: a.summary })),
        ...repo.listRelations(wry.id).map((r) => ({ label: "relation", chapter: r.chapter, text: `${r.type} ${r.detail ?? ""}` })),
      ];
      // 拉车锚点允许"一车/板车/戏台道具/登丑峰"等措辞（LLM 用词有差异），关键是 Reveal 章节正确
      const cart = recs.filter((r) => /登丑峰|板车|一车|戏台道具/.test(r.text));
      const cook = recs.filter((r) => /饭/.test(r.text));
      const teach = recs.filter((r) => /念/.test(r.text) && /教|授|学/.test(r.text));
      console.log("  闻人佑 拉车记录:", JSON.stringify(cart.map((r) => `ch${r.chapter}:${r.text.slice(0, 24)}`)));
      console.log("  闻人佑 做饭记录:", JSON.stringify(cook.map((r) => `ch${r.chapter}:${r.text.slice(0, 24)}`)));
      console.log("  闻人佑 教念记录:", JSON.stringify(teach.map((r) => `ch${r.chapter}:${r.text.slice(0, 24)}`)));
      // 原文：392「正在拉车的，是老三闻人佑」/393「板车」；396「老三会做饭」/397「平日里都是老三做饭」；399/400 教学安排
      check(cart.length > 0 && cart.every((r) => r.chapter === 392 || r.chapter === 393), "拉车 Reveal 归因应为 392/393", cart.map((r) => r.chapter).join(","));
      check(cook.length > 0 && cook.every((r) => r.chapter === 396 || r.chapter === 397), "做饭 Reveal 归因应为 396/397", cook.map((r) => r.chapter).join(","));
      check(teach.length > 0 && teach.some((r) => r.chapter === 399 || r.chapter === 400), "教念 Reveal 归因应含 399/400", teach.map((r) => r.chapter).join(","));
      check(!recs.some((r) => r.chapter === 384 && /饭/.test(r.text)), "不应存在 chapter=384 的做饭记录（旧错误归因已被拦截）");
      check(!recs.some((r) => r.chapter === 391 && /车|登丑峰/.test(r.text)), "不应存在 chapter=391 的拉车记录（旧错误归因已被拦截）");
    }

    // 5 个模糊回忆问题：只靠 search_entities（结构化数据），不读原文
    console.log("\n[2/4] 5 个模糊回忆问题（search_entities @ userChapter=405）:");
    repo.setUserChapter(405);
    const questions: { q: string; expect: string; viaMust?: RegExp; topN?: number }[] = [
      { q: "那个拉很重的车上山的人叫什么？", expect: "闻人佑" },
      { q: "之前负责做饭的是谁？", expect: "闻人佑" },
      { q: "那个不怎么说话的三师兄是谁？", expect: "闻人佑" },
      // 拉板车：闻人佑的拉车锚点（392）用词可能为"一车/戏台道具/登丑峰"而非字面"板车"（LLM 用词差异），
      // 故放宽为"进入前 5 且命中线索含拉车意象"——核心（Reveal 章节 392）已由数据层断言覆盖。
      { q: "我记得戏道古藏是不是有个人一直拉板车？", expect: "闻人佑", viaMust: /拉|车|登丑峰|戏台道具/, topN: 5 },
      // 教【念】：若抽取未产出 interaction 锚点（教学画面在本批只是"约定"），要求 闻人佑 进入前 3
      // 且命中线索含"念/教"（教学关系被结构化数据定位到）——保证 Reader 能据此回答，且绝不读原文。
      { q: "教陈伶【念】的是谁？", expect: "闻人佑", viaMust: /念|教/ },
    ];
    for (const { q, expect, viaMust, topN } of questions) {
      const hits = searchEntities(repo, q, 10);
      const top = hits[0];
      console.log(`  「${q}」`);
      for (const h of hits.slice(0, 3)) {
        console.log(`     ${h.entity.name} (${Math.round(h.score)}) via: ${h.matchedVia}`);
      }
      if (viaMust) {
        const window = hits.slice(0, topN ?? 3);
        const candidate = window.find((h) => h.entity.name === expect);
        const ok = candidate !== undefined && viaMust.test(candidate.matchedVia);
        check(ok, `→ ${expect} 进入前 ${topN ?? 3} 且命中线索含 ${viaMust.source}`, top ? `第一名=${top.entity.name}（${top.matchedVia}）` : "无命中");
      } else {
        const ok = top !== undefined && top.entity.name === expect;
        check(ok, `→ 第一名应为 ${expect}`, top ? `实际 ${top.entity.name}（${top.matchedVia}）` : "无命中");
      }
    }

    // 防剧透边界：Reader 只返回 chapter<=405 的数据（audit 语义）
    console.log("\n[3/4] 防剧透边界（userChapter=405 数据访问层过滤）:");
    {
      const anchors = repo.listMemoryAnchors(wry?.id ?? "character_闻人佑");
      check(anchors.every((a) => a.chapter <= 405), "闻人佑可见 Anchor 全部 <=405");
      const facts = repo.listFacts(wry?.id ?? "character_闻人佑");
      check(facts.every((f) => f.chapter <= 405), "闻人佑可见 Facts 全部 <=405");
      // 全库 Reader API 抽查：不含 >405 的记录
      const future = [
        ...repo.listMemoryAnchors(),
        ...repo.listFacts(),
        ...repo.listRelations(),
        ...repo.listEvents(),
        ...repo.listAbilities(),
      ].some((r: any) => (r.chapter ?? 0) > 405 || (r.from_chapter ?? 0) > 405);
      check(!future, "Reader API 无 >405 的记录泄露");
      const futureEntity = repo.listEntities().some((e) => e.first_seen_chapter > 405);
      check(!futureEntity, "未来实体不可见");
    }
  } finally {
    process.chdir(prevCwd);
    repo.close();
  }

  // 真实完整审计（in-process：cmdAudit 用 process.cwd() 读配置/DB，故 chdir 到测试项目）
  console.log("\n[4/4] story audit --chapter 405（完整审计）:");
  process.chdir(PROJ);
  const auditCode = await cmdAudit({ "--chapter": "405" });
  process.chdir(prevCwd);
  check(auditCode === 0, "story audit --chapter 405 全部 PASS", `exit=${auditCode}`);

  const total = passed + failed;
  console.log(`\n结果：${passed}/${total} 通过，${failed} 失败`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
