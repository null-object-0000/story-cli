// story character <名字>：人物卡片（纯结构化数据渲染）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { searchEntities, guessProtagonist } from "../ask/search.js";
import { buildEntityCard } from "../ask/context.js";
import { topAnchors } from "../ask/recall.js";
import { log, warn, section } from "../logger.js";

export async function cmdCharacter(name: string): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath());
  try {
    // character 属于 Reader 功能：严格受 userChapter 约束（不得泄露超出阅读进度的信息）
    repo.setUserChapter(cfg.userChapter);
    const hits = searchEntities(repo, name, 3);
    if (!hits.length) {
      warn(`未找到「${name}」（结构化库中不存在，可能是抽取缺失）`);
      return 1;
    }
    const hit = hits[0];
    if (hit.score < 10) {
      warn(`未找到「${name}」，最接近的是「${hit.entity.name}」（分数 ${Math.round(hit.score)}）`);
      if (hits.length > 1) warn(`其他候选：${hits.slice(1).map((h) => h.entity.name).join("、")}`);
      return 1;
    }
    const card = buildEntityCard(repo, hit.entity);
    const protagonist = guessProtagonist(repo);

    section(`人物卡片：${card.name}`);
    if (card.identityFacts.length) {
      log("\n身份：");
      for (const f of card.identityFacts) log(`  ${f.value}（第${f.chapter}章）`);
    }
    log(`\n首次正式出现：`);
    log(`  第${card.firstSeenChapter ?? "?"}章`);
    log(`\n最近出现：`);
    log(`  第${card.lastSeenChapter ?? "?"}章（共出现在 ${card.appearanceChapterCount} 章）`);
    if (card.aliases.length) {
      log("\n别名：");
      log(`  ${card.aliases.map((a) => a.alias).join("、")}`);
    }
    if (card.personalityFacts.length) {
      log("\n性格/特征：");
      for (const f of card.personalityFacts) log(`  ${f.value}（第${f.chapter}章）`);
    }
    const anchors = topAnchors(repo.listMemoryAnchors(hit.entity.id), cfg.userChapter, 5);
    if (anchors.length) {
      log("\n你可能记得ta因为：");
      for (const a of anchors) log(`  ${a.chapter}章：${a.summary}`);
    }
    if (card.relations.length) {
      log("\n关系：");
      const rels = card.relations.filter((r) => r.protagonist);
      const others = card.relations.filter((r) => !r.protagonist);
      for (const r of [...rels, ...others]) {
        const tag = r.protagonist ? "（主角）" : "";
        log(`  ${card.name} — ${r.type}${tag}：${r.detail ?? ""}（第${r.chapter}章）`);
      }
    }
    if (card.recentEvents.length) {
      log("\n近期相关事件：");
      for (const e of card.recentEvents) log(`  ${e.chapter}章：${e.summary}`);
    }
    if (protagonist && hit.entity.id === protagonist.id) {
      log("\n（主角）");
    }
    return 0;
  } finally {
    repo.close();
  }
}