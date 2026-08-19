// 快速：只对已重建的测试库跑 5 个模糊回忆问题（不触发 LLM）
import { StoryRepo } from "../src/db/repo.js";
import { searchEntities } from "../src/reader/search.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const DB = join(ROOT, "test", ".e2e", "recall-proj", ".story", "story.db");

const repo = new StoryRepo(DB);
repo.setUserChapter(405);
const questions = [
  "那个拉很重的车上山的人叫什么？",
  "之前负责做饭的是谁？",
  "那个不怎么说话的三师兄是谁？",
  "我记得戏道古藏是不是有个人一直拉板车？",
  "教陈伶【念】的是谁？",
];
for (const q of questions) {
  const hits = searchEntities(repo, q, 5);
  console.log(`「${q}」`);
  for (const h of hits.slice(0, 3)) {
    console.log(`   ${h.entity.name} (${Math.round(h.score)}) via: ${h.matchedVia}`);
  }
}
const wry = repo.findEntityByNameRaw("闻人佑");
if (wry) {
  console.log("\n闻人佑 facts:", JSON.stringify(repo.listFacts(wry.id).map((f) => f.value)));
  console.log("闻人佑 anchors:", JSON.stringify(repo.listMemoryAnchors(wry.id).map((a) => `${a.kind}:${a.summary}`)));
}
repo.close();
