// 结构化数据内的人物搜索：名称/别名精确匹配 + 全文片段 shingle 重叠。
// 搜索范围只包含：实体名、别名、事实、记忆锚点、事件摘要、关系（全部来自结构化库，禁止原文）。
// 支持主角特殊提权（"主角"关键词命中时最高分）。

import { StoryRepo, EntityRow, FactRow, MemoryAnchorRow } from "../db/repo.js";
import { normalizeText, shingles, overlap } from "../util.js";

export interface EntityHit {
  entity: EntityRow;
  score: number;
  matchedVia: string;
}

interface Searchable {
  entity: EntityRow;
  names: string[];
  factText: string;
  anchorText: string;
  eventText: string;
  relationText: string;
}

export function buildSearchIndex(repo: StoryRepo): Searchable[] {
  const entities = repo.listEntities();
  const aliases = repo.listAliases();
  const aliasByEntity = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasByEntity.get(a.entity_id) ?? [];
    arr.push(a.alias);
    aliasByEntity.set(a.entity_id, arr);
  }
  const facts: FactRow[] = repo.listFacts();
  const anchors: MemoryAnchorRow[] = repo.listMemoryAnchors();
  const factTextByEntity = new Map<string, string>();
  for (const f of facts) {
    if (["role", "identity", "occupation", "affiliation", "status"].includes(f.type)) {
      factTextByEntity.set(f.entity_id, (factTextByEntity.get(f.entity_id) ?? "") + " " + f.value);
    }
  }
  const anchorTextByEntity = new Map<string, string>();
  for (const a of anchors) {
    anchorTextByEntity.set(a.entity_id, (anchorTextByEntity.get(a.entity_id) ?? "") + " " + a.summary);
  }
  const eventTextByEntity = new Map<string, string>();
  for (const e of repo.listEvents()) {
    for (const p of JSON.parse(e.participants) as string[]) {
      eventTextByEntity.set(p, (eventTextByEntity.get(p) ?? "") + " " + e.summary);
    }
  }
  const relationTextByEntity = new Map<string, string>();
  for (const r of repo.listRelations()) {
    const fName = repo.getEntity(r.from_entity_id)?.name ?? r.from_entity_id;
    const tName = repo.getEntity(r.to_entity_id)?.name ?? r.to_entity_id;
    const text = [r.type, r.detail, fName, tName].filter(Boolean).join(" ");
    relationTextByEntity.set(r.from_entity_id, (relationTextByEntity.get(r.from_entity_id) ?? "") + " " + text);
    relationTextByEntity.set(r.to_entity_id, (relationTextByEntity.get(r.to_entity_id) ?? "") + " " + text);
  }
  return entities.map((entity) => ({
    entity,
    names: [entity.name, ...(aliasByEntity.get(entity.id) ?? [])],
    factText: factTextByEntity.get(entity.id) ?? "",
    anchorText: anchorTextByEntity.get(entity.id) ?? "",
    eventText: eventTextByEntity.get(entity.id) ?? "",
    relationText: relationTextByEntity.get(entity.id) ?? "",
  }));
}

export function searchEntities(repo: StoryRepo, query: string, topK = 5): EntityHit[] {
  const q = normalizeText(query);
  if (!q) return [];
  const qShingles = shingles(query, 2);
  const index = buildSearchIndex(repo);
  const protagonist = guessProtagonist(repo);
  const hits: EntityHit[] = [];

  for (const s of index) {
    let score = 0;
    let via = "";
    // 主角提权：当查询包含"主角"时，主角实体+60
    if (protagonist && s.entity.id === protagonist.id && /主角/.test(query)) {
      score = Math.max(score, 60);
      via = "主角";
    }
    for (const name of s.names) {
      const n = normalizeText(name);
      if (n === q) {
        score = Math.max(score, 100);
        via = `名称「${name}」精确匹配`;
      } else if (n.length >= 2 && (q.includes(n) || n.includes(q))) {
        score = Math.max(score, 55);
        via = via || `名称「${name}」`;
      } else {
        const o = overlap(qShingles, shingles(name, 2));
        if (o > 0) {
          if (score < 20 + o * 8) via = `名称「${name}」`;
          score = Math.max(score, 20 + o * 8);
        }
      }
    }
    const factOverlap = overlap(qShingles, shingles(s.factText, 2));
    if (factOverlap > 0) {
      if (score < 10 + factOverlap * 4) via = `身份/事实「${s.factText.trim().slice(0, 24)}」`;
      score = Math.max(score, 10 + factOverlap * 4);
    }
    const anchorOverlap = overlap(qShingles, shingles(s.anchorText, 2));
    if (anchorOverlap > 0) {
      if (score < 8 + anchorOverlap * 4) via = `记忆锚点`;
      score = Math.max(score, 8 + anchorOverlap * 4);
    }
    const eventOverlap = overlap(qShingles, shingles(s.eventText, 2));
    if (eventOverlap > 0 && score < 4 + eventOverlap * 2) {
      via = `事件摘要`;
      score = Math.max(score, 4 + eventOverlap * 2);
    }
    const relOverlap = overlap(qShingles, shingles(s.relationText, 2));
    if (relOverlap > 0) {
      if (score < 6 + relOverlap * 3) via = `关系`;
      score = Math.max(score, 6 + relOverlap * 3);
    }
    if (score > 0) hits.push({ entity: s.entity, score, matchedVia: via });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** 主角估计：出现章节数最多的人物 */
export function guessProtagonist(repo: StoryRepo): EntityRow | null {
  const entities = repo.listEntities("character");
  let best: EntityRow | null = null;
  let bestN = -1;
  for (const e of entities) {
    const { count } = repo.firstAndLastAppearance(e.id);
    if (count > bestN) {
      bestN = count;
      best = e;
    }
  }
  return best;
}