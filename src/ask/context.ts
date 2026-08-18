// 构建 STRUCTURED STORY DATA（结构化上下文）。
// 这是 Ask 阶段给 LLM 的全部数据来源；只读结构化表，绝不读取 chapters 原文。
// 所有条目天然满足 chapter <= userChapter（StoryRepo 可见性过滤保证）。

import { StoryRepo, EntityRow } from "../db/repo.js";
import { Intent } from "./intent.js";
import { EntityHit, guessProtagonist } from "./search.js";
import { topAnchors } from "./recall.js";

export interface EntityCard {
  entityId: string;
  name: string;
  type: string;
  isProtagonist: boolean;
  aliases: { alias: string; fromChapter: number }[];
  firstSeenChapter: number | null;
  lastSeenChapter: number | null;
  appearanceChapterCount: number;
  identityFacts: { type: string; value: string; chapter: number; confidence: number }[];
  personalityFacts: { type: string; value: string; chapter: number; confidence: number }[];
  recallAnchors: { chapter: number; summary: string; score: number }[];
  relations: { with: string; type: string; detail: string | null; chapter: number; confidence: number; protagonist: boolean }[];
  recentEvents: { chapter: number; type: string; summary: string }[];
}

export interface StructuredContext {
  meta: { book: string; availableThrough: number; userChapter: number; protagonistName?: string | null };
  intent: Intent;
  question: string;
  matchedEntities: EntityCard[];        // 主要命中
  candidates?: EntityCard[];            // ENTITY_SEARCH 的候选
  abilities?: {
    entityName: string;
    name: string;
    category: string | null;
    system: string | null;
    path: string | null;
    level: string | null;
    sourceEntity: string | null;
    acquiredChapter: number | null;
    summary: string | null;
    chapter: number;
  }[];
  abilityId?: string;                   // ABILITY_LOOKUP 指定能力名
  relationPair?: { a: string; b: string };
}

export function buildEntityCard(repo: StoryRepo, entity: EntityRow, protagonistId?: string | null, userChapter?: number): EntityCard {
  const aliases = repo.listAliases(entity.id).map((a) => ({ alias: a.alias, fromChapter: a.from_chapter }));
  const facts = repo.listFacts(entity.id);
  const identityFacts = facts
    .filter((f) => ["role", "identity", "occupation", "affiliation", "status"].includes(f.type))
    .map((f) => ({ type: f.type, value: f.value, chapter: f.chapter, confidence: f.confidence }));
  const personalityFacts = facts
    .filter((f) => ["personality", "appearance", "habit", "description"].includes(f.type))
    .map((f) => ({ type: f.type, value: f.value, chapter: f.chapter, confidence: f.confidence }));
  const { first, last, count } = repo.firstAndLastAppearance(entity.id);
  // userChapter 缺省 = availableThrough（当前已导入的最大章节），Reader 路径总是显式传入
  const uc = userChapter ?? repo.availableThrough() ?? 0;
  const anchors = topAnchors(repo.listMemoryAnchors(entity.id), uc, 5).map((a) => ({
    chapter: a.chapter,
    summary: a.summary,
    score: Math.round(
      ((0.35 * a.importance + 0.35 * a.memorability + 0.15 * a.protagonist_relevance + 0.15 * (uc > 0 ? a.chapter / uc : 0)) * 100)
    ) / 100,
  }));
  const protagonist = guessProtagonist(repo);
  const relations = repo
    .listRelations(entity.id)
    .filter((r) => r.from_entity_id === entity.id || r.to_entity_id === entity.id)
    .map((r) => {
      const otherId = r.from_entity_id === entity.id ? r.to_entity_id : r.from_entity_id;
      const other = repo.getEntity(otherId);
      return {
        with: other?.name ?? otherId,
        type: r.type,
        detail: r.detail,
        chapter: r.chapter,
        confidence: r.confidence,
        protagonist: protagonist ? otherId === protagonist.id : false,
      };
    });
  const recentEvents = repo
    .listEvents()
    .filter((e) => {
      try {
        return (JSON.parse(e.participants) as string[]).includes(entity.id);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.chapter - a.chapter)
    .slice(0, 6)
    .map((e) => ({ chapter: e.chapter, type: e.type, summary: e.summary }));

  return {
    entityId: entity.id,
    name: entity.name,
    type: entity.type,
    isProtagonist: protagonistId === entity.id,
    aliases,
    firstSeenChapter: first,
    lastSeenChapter: last,
    appearanceChapterCount: count,
    identityFacts,
    personalityFacts,
    recallAnchors: anchors,
    relations,
    recentEvents,
  };
}

export function buildContext(
  repo: StoryRepo,
  cfg: { book: string; userChapter: number },
  question: string,
  intent: Intent,
  hits: EntityHit[],
  opts: { abilityNames?: string[] } = {}
): StructuredContext {
    const protagonist = guessProtagonist(repo);
  const meta = { book: cfg.book, availableThrough: repo.availableThrough() ?? 0, userChapter: cfg.userChapter, protagonistName: protagonist?.name ?? null };
  const cards = hits.slice(0, 3).map((h) => buildEntityCard(repo, h.entity, protagonist?.id ?? null, cfg.userChapter));
  const ctx: StructuredContext = { meta, intent, question, matchedEntities: cards };

  if (intent === "LIST_ABILITIES" || intent === "ABILITY_LOOKUP") {
    const target = hits[0]?.entity;
    if (target) {
      ctx.abilities = repo.listAbilities(target.id).map((a) => ({
        entityName: repo.getEntity(a.entity_id)?.name ?? a.entity_id,
        name: a.name,
        category: a.category,
        system: a.system,
        path: a.path,
        level: a.level,
        sourceEntity: a.source_entity,
        acquiredChapter: a.acquired_chapter,
        summary: a.summary,
        chapter: a.chapter,
      }));
    }
  }

  if (intent === "ENTITY_SEARCH") {
    ctx.candidates = hits.slice(0, 5).map((h) => buildEntityCard(repo, h.entity));
  }

  if ((intent === "CHARACTER_RELATION") && hits.length >= 2) {
    ctx.relationPair = { a: hits[0].entity.name, b: hits[1].entity.name };
  }

  return ctx;
}