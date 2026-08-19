// 对已重建的测试库验证 recall-test 的断言（无需重跑 LLM build）
import { StoryRepo } from "../src/db/repo.js";
import { searchEntities } from "../src/reader/search.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DB = join(ROOT, "test", ".e2e", "recall-proj", ".story", "story.db");

let pass = 0, fail = 0;
const check = (c: boolean, name: string, d = ""): void => { console.log(`  ${c ? "✔" : "✘"} ${name}${d && !c ? " — " + d : ""}`); c ? pass++ : fail++; };

const repo = new StoryRepo(DB);
// 数据层断言（Build 模式）
const wry = repo.findEntityByNameRaw("闻人佑");
if (!wry) {
  console.log("  ✘ 闻人佑实体不存在");
  process.exit(1);
}
const recs = [
  ...repo.listFacts(wry.id).map((f) => ({ chapter: f.chapter, text: f.value })),
  ...repo.listMemoryAnchors(wry.id).map((a) => ({ chapter: a.chapter, text: a.summary })),
  ...repo.listRelations(wry.id).map((r) => ({ chapter: r.chapter, text: `${r.type} ${r.detail ?? ""}` })),
];
const cart = recs.filter((r) => /登丑峰|板车|一车|戏台道具/.test(r.text));
const cook = recs.filter((r) => /饭/.test(r.text));
const teach = recs.filter((r) => /念/.test(r.text) && /教|授|学/.test(r.text));
check(cart.length > 0 && cart.every((r) => r.chapter === 392 || r.chapter === 393), "拉车 Reveal 归因 392/393", cart.map((r) => `ch${r.chapter}`).join(","));
check(cook.length > 0 && cook.every((r) => r.chapter === 396 || r.chapter === 397), "做饭 Reveal 归因 396/397", cook.map((r) => `ch${r.chapter}`).join(","));
check(teach.length > 0 && teach.some((r) => r.chapter === 399 || r.chapter === 400), "教念 Reveal 归因 399/400", teach.map((r) => `ch${r.chapter}`).join(","));
check(!recs.some((r) => r.chapter === 384 && /饭/.test(r.text)), "无 chapter=384 做饭（旧错误归因已拦截）");
check(!recs.some((r) => r.chapter === 391 && /车|登丑峰/.test(r.text)), "无 chapter=391 拉车（旧错误归因已拦截）");

// 搜索层断言（Reader 模式）
repo.setUserChapter(405);
const qs = [
  { q: "那个拉很重的车上山的人叫什么？", n: 1 },
  { q: "之前负责做饭的是谁？", n: 1 },
  { q: "那个不怎么说话的三师兄是谁？", n: 1 },
  { q: "我记得戏道古藏是不是有个人一直拉板车？", viaMust: /拉|车|登丑峰|戏台道具/, topN: 5 },
  { q: "教陈伶【念】的是谁？", viaMust: /念|教/ },
];
for (const { q, n, viaMust, topN } of qs) {
  const hits = searchEntities(repo, q, 10);
  const names = hits.slice(0, 5).map((h) => `${h.entity.name}(${Math.round(h.score)})`).join(" ");
  if (viaMust) {
    const cand = hits.slice(0, topN ?? 3).find((h) => h.entity.name === "闻人佑");
    check(cand !== undefined && viaMust.test(cand.matchedVia), `「${q}」→ 闻人佑 前${topN ?? 3} 且含 ${viaMust.source}`, names);
  } else {
    check(hits[0]?.entity.name === "闻人佑", `「${q}」→ 第一名 闻人佑`, names);
  }
}
console.log(`\n结果：${pass}/${pass + fail} 通过`);
repo.close();
