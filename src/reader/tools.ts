// 小说领域 Agent 工具：全部只读结构化数据（StoryRepo），绝不触碰 chapters 原文。
// 基于 pi-agent-core 的 AgentTool 定义；参数用 TypeBox schema。
// 「选定章节」：set_chapter_focus 设定工作区焦点区间，其余工具按焦点过滤带章节号的数据。

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StoryRepo } from "../db/repo.js";
import { searchEntities } from "./search.js";
import { buildEntityCard, EntityCard } from "./context.js";
import { buildEntityIndexDigest } from "./answer.js";
import { stableJson } from "../util.js";

// 本地工具类型：pi 的 AgentTool<any> 会把 execute 的 params 解析为 unknown，
// 这里自定义 params: any，并保持与 AgentTool<any> 结构兼容（any 可赋给 unknown）。
export interface NovelTool {
  name: string;
  label: string;
  description: string;
  /** TypeBox schema 对象 */
  parameters: any;
  executionMode?: "sequential" | "parallel";
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (partial: AgentToolResult<any>) => void
  ) => Promise<AgentToolResult<any>>;
}

export interface NovelToolContext {
  repo: StoryRepo;
  book: string;
  /** 当前已导入的最大章节（availableThrough，由 chapters 数据决定；仅用于展示/进度） */
  availableThrough: number;
  /** 用户当前阅读进度（Ask 检索过滤边界：所有工具只返回 chapter <= userChapter 的数据） */
  userChapter: number;
  /** 当前工作区章节焦点（null 表示不限制，与 userChapter 叠加：final cap = min(focus.to, userChapter)） */
  focus: { from: number | null; to: number | null };
}

// 各工具的入参类型（与 TypeBox schema 对应；运行时经 pi 校验）
interface SearchEntitiesParams { query: string; topK?: number }
interface GetEntityParams { name: string }
interface ListAbilitiesParams { entity_name?: string }
interface GetRelationsParams { entity_a: string; entity_b?: string }
interface ListEventsParams { entity_name?: string; from_chapter?: number; to_chapter?: number; limit?: number }
interface GetEntityIndexParams { topN?: number }
interface GetProgressParams {}
interface ListChaptersParams { from_chapter?: number; to_chapter?: number; limit?: number }
interface SetChapterFocusParams { from_chapter?: number; to_chapter?: number }

export function textResult(content: unknown, details: Record<string, unknown> = {}): AgentToolResult<any> {
  return { content: [{ type: "text", text: typeof content === "string" ? content : stableJson(content) }], details };
}

/** 把任意值转成对 LLM 友好的紧凑 JSON 文本 */
function jsonText(v: unknown): string {
  return stableJson(v);
}

function inFocus(ctx: NovelToolContext, chapter: number): boolean {
  if (ctx.focus.from !== null && chapter < ctx.focus.from) return false;
  if (ctx.focus.to !== null && chapter > ctx.focus.to) return false;
  return true;
}

function filterEntityCardByFocus(card: EntityCard, ctx: NovelToolContext): EntityCard {
  const focus = ctx.focus;
  if (focus.from === null && focus.to === null) return card;
  return {
    ...card,
    identityFacts: card.identityFacts.filter((f) => inFocus(ctx, f.chapter)),
    personalityFacts: card.personalityFacts.filter((f) => inFocus(ctx, f.chapter)),
    recallAnchors: card.recallAnchors.filter((a) => inFocus(ctx, a.chapter)),
    relations: card.relations.filter((r) => inFocus(ctx, r.chapter)),
    recentEvents: card.recentEvents.filter((e) => inFocus(ctx, e.chapter)),
  };
}

/** 通过名称/别名/ID 解析实体；找不到返回 null */
function resolveByNameOrAlias(ctx: NovelToolContext, name: string) {
  const repo = ctx.repo;
  const clean = (name ?? "").trim();
  if (!clean) return null;
  return (
    repo.findEntityByName(clean) ??
    repo.findByAlias(clean) ??
    (repo.resolveEntity(clean) ?? null)
  );
}

export function buildNovelTools(ctx: NovelToolContext): NovelTool[] {
  const repo = ctx.repo;

  return [
    {
      name: "search_entities",
      label: "搜索实体",
      description:
        "在小说结构化数据中模糊搜索人物/组织/地点等实体。适合用户只记得外号、身份或零散特征（如「做饭的三师兄」「拉板车的人」）时定位是谁。返回按匹配度排序的候选。",
      parameters: Type.Object({
        query: Type.String({ description: "用户的描述或特征，原样传入" }),
        topK: Type.Optional(Type.Integer({ description: "返回候选数，默认 5，最大 10" })),
      }),
      execute: async (_id, params: SearchEntitiesParams) => {
        const hits = searchEntities(repo, params.query, Math.min(params.topK ?? 5, 10));
        const list = hits.map((h) => ({
          id: h.entity.id,
          name: h.entity.name,
          type: h.entity.type,
          score: Math.round(h.score),
          matchedVia: h.matchedVia,
          description: h.entity.description,
        }));
        return textResult(list.length ? jsonText(list) : "没有找到任何匹配的实体。", { count: list.length });
      },
    },
    {
      name: "get_entity",
      label: "获取实体详情",
      description:
        "获取某个人物/组织的完整结构化档案：身份事实、性格外观、记忆锚点、关系、近期事件、出场章节。回答「这个人是谁/他经历了什么/他和主角什么关系」类问题前先调用本工具。注意：数据按当前章节焦点过滤。",
      parameters: Type.Object({
        name: Type.String({ description: "实体名称、别名或 ID（如 闻人佑 / 三师兄）" }),
      }),
      execute: async (_id, params: GetEntityParams) => {
        const entity = resolveByNameOrAlias(ctx, params.name);
        if (!entity) {
          return textResult(`结构化数据中不存在名为「${params.name}」的实体。可先调用 search_entities 确认。`);
        }
        const protagonist = searchEntities(repo, "主角", 1)[0]?.entity ?? null;
        const card = filterEntityCardByFocus(buildEntityCard(repo, entity, protagonist?.id ?? null, ctx.userChapter), ctx);
        return textResult(jsonText(card), { entityId: entity.id });
      },
    },
    {
      name: "list_abilities",
      label: "列出能力",
      description: "列出某个实体的能力清单（体系/途径/级别/来源/获得章节/说明）。不带 entity_name 时列出全书所有能力。",
      parameters: Type.Object({
        entity_name: Type.Optional(Type.String({ description: "实体名称或别名；省略则列出全部" })),
      }),
      execute: async (_id, params: ListAbilitiesParams) => {
        let rows = params.entity_name
          ? (() => {
              const entity = resolveByNameOrAlias(ctx, params.entity_name);
              if (!entity) return [];
              return repo.listAbilities(entity.id);
            })()
          : repo.listAbilities();
        if (ctx.focus.from !== null || ctx.focus.to !== null) {
          rows = rows.filter((a) => inFocus(ctx, a.chapter));
        }
        const list = rows.map((a) => ({
          entity: repo.getEntity(a.entity_id)?.name ?? a.entity_id,
          name: a.name,
          category: a.category,
          system: a.system,
          path: a.path,
          level: a.level,
          source: a.source_entity,
          acquiredChapter: a.acquired_chapter,
          summary: a.summary,
          chapter: a.chapter,
        }));
        return textResult(list.length ? jsonText(list) : "没有找到任何能力记录。", { count: list.length });
      },
    },
    {
      name: "get_relations",
      label: "查询关系",
      description: "查询实体之间的关系。只给 entity_a 时返回该实体的全部关系；同时给 entity_a/entity_b 时返回两者之间的直接关系。",
      parameters: Type.Object({
        entity_a: Type.String({ description: "实体名称或别名" }),
        entity_b: Type.Optional(Type.String({ description: "另一个实体名称或别名（可选）" })),
      }),
      execute: async (_id, params: GetRelationsParams) => {
        const a = resolveByNameOrAlias(ctx, params.entity_a);
        if (!a) return textResult(`结构化数据中不存在名为「${params.entity_a}」的实体。`);
        const nameOf = (id: string) => repo.getEntity(id)?.name ?? id;
        let rels = repo.listRelations(a.id);
        if (ctx.focus.from !== null || ctx.focus.to !== null) {
          rels = rels.filter((r) => inFocus(ctx, r.chapter));
        }
        if (params.entity_b) {
          const b = resolveByNameOrAlias(ctx, params.entity_b);
          if (!b) return textResult(`结构化数据中不存在名为「${params.entity_b}」的实体。`);
          rels = rels.filter((r) => r.from_entity_id === b.id || r.to_entity_id === b.id);
        }
        const list = rels.map((r) => ({
          from: nameOf(r.from_entity_id),
          to: nameOf(r.to_entity_id),
          type: r.type,
          detail: r.detail,
          chapter: r.chapter,
          confidence: r.confidence,
        }));
        return textResult(list.length ? jsonText(list) : "没有找到相关的关系记录。", { count: list.length });
      },
    },
    {
      name: "list_events",
      label: "列出事件",
      description: "列出重要事件（带章节号与参与者）。可按实体过滤、按章节区间过滤。回答「最近发生了什么」「X 在第 N 章前后经历了什么」类问题用。",
      parameters: Type.Object({
        entity_name: Type.Optional(Type.String({ description: "只列出该实体参与的事件（可选）" })),
        from_chapter: Type.Optional(Type.Integer({ description: "起始章节（含），可选" })),
        to_chapter: Type.Optional(Type.Integer({ description: "结束章节（含），可选" })),
        limit: Type.Optional(Type.Integer({ description: "最多返回条数，默认 20" })),
      }),
      execute: async (_id, params: ListEventsParams) => {
        let events = repo.listEvents(params.entity_name ? resolveByNameOrAlias(ctx, params.entity_name)?.id : undefined);
        const from = params.from_chapter ?? ctx.focus.from;
        const to = params.to_chapter ?? ctx.focus.to;
        if (from !== null && from !== undefined) events = events.filter((e) => e.chapter >= from);
        if (to !== null && to !== undefined) events = events.filter((e) => e.chapter <= to);
        events = [...events].sort((a, b) => b.chapter - a.chapter).slice(0, params.limit ?? 20);
        const list = events.map((e) => ({
          chapter: e.chapter,
          type: e.type,
          summary: e.summary,
          participants: safeParseParticipants(e.participants).map((id) => repo.getEntity(id)?.name ?? id),
          importance: e.importance,
        }));
        return textResult(list.length ? jsonText(list) : "没有找到符合条件的事件。", { count: list.length });
      },
    },
    {
      name: "get_entity_index",
      label: "全实体索引",
      description:
        "获取全书实体总览：每个实体的类型、别名、首次出场章节、出场次数、身份摘要，以及关系清单。适合用户问「这本书里有哪些人」或检索目标不明确时快速浏览。",
      parameters: Type.Object({
        topN: Type.Optional(Type.Integer({ description: "最多列出的实体数，默认 30" })),
      }),
      execute: async (_id, params: GetEntityIndexParams) => {
        const digest = buildEntityIndexDigest(repo, ctx.userChapter, params.topN ?? 30);
        return textResult(digest);
      },
    },
    {
      name: "get_progress",
      label: "阅读进度",
      description: "获取当前工作区信息：书名、阅读进度（用户当前读到第几章）、已导入章节数（availableThrough）、已构建章节数（builtThrough）、主角、已读范围内的结构化数据量统计。回答「我现在读到哪了」或需要了解整体情况时调用。",
      parameters: Type.Object({}),
      execute: async () => {
        const protagonist = searchEntities(repo, "主角", 1)[0]?.entity ?? null;
        const counts = repo.counts();
        return textResult(
          jsonText({
            book: ctx.book,
            availableThrough: ctx.availableThrough,
            builtThrough: repo.builtThrough() ?? 0,
            userChapter: ctx.userChapter,
            protagonist: protagonist?.name ?? null,
            focus: ctx.focus,
            counts: {
              characters: counts.characters,
              entities: counts.entities,
              abilities: counts.abilities,
              events: counts.events,
              relations: counts.relations,
              facts: counts.facts,
              memoryAnchors: counts.memoryAnchors,
            },
          })
        );
      },
    },
    {
      name: "list_chapters",
      label: "章节目录",
      description: "列出章节元信息（章节号、标题、字数），不含正文。可按区间过滤。回答「第 N 章叫什么」「某章大概多长」类问题用。",
      parameters: Type.Object({
        from_chapter: Type.Optional(Type.Integer({ description: "起始章节（含），可选" })),
        to_chapter: Type.Optional(Type.Integer({ description: "结束章节（含），可选" })),
        limit: Type.Optional(Type.Integer({ description: "最多返回条数，默认 50" })),
      }),
      execute: async (_id, params: ListChaptersParams) => {
        let chapters = repo.listChapterMeta();
        const from = params.from_chapter ?? ctx.focus.from;
        const to = params.to_chapter ?? ctx.focus.to;
        if (from !== null && from !== undefined) chapters = chapters.filter((c) => c.chapter >= from);
        if (to !== null && to !== undefined) chapters = chapters.filter((c) => c.chapter <= to);
        chapters = chapters.slice(0, params.limit ?? 50);
        const list = chapters.map((c) => ({ chapter: c.chapter, title: c.title, chars: c.chars }));
        return textResult(list.length ? jsonText(list) : "没有找到符合条件章节。", { count: list.length });
      },
    },
    {
      name: "set_chapter_focus",
      label: "设定章节焦点",
      description:
        "把工作区焦点设定到某个章节区间，之后所有带章节号的数据（事实/事件/能力/关系/锚点/章节目录）都只返回该区间内的。用于回答「第 100 章之前」「200-300 章之间」这类限定范围的问题。调用后应立即告诉用户焦点已切换。",
      parameters: Type.Object({
        from_chapter: Type.Optional(Type.Integer({ description: "起始章节（含）；省略表示不设下限" })),
        to_chapter: Type.Optional(Type.Integer({ description: "结束章节（含）；省略表示不设上限" })),
      }),
      execute: async (_id, params: SetChapterFocusParams) => {
        const from = params.from_chapter ?? null;
        const to = params.to_chapter ?? null;
        const validFrom = from === null ? null : Math.max(1, from);
        // 焦点上限不能超过用户阅读进度（userChapter）——防剧透边界
        const cap = ctx.userChapter;
        const validTo = to === null ? null : Math.min(cap, to);
        if (validFrom !== null && validTo !== null && validFrom > validTo) {
          return textResult(`无效区间：${validFrom} > ${validTo}（当前阅读进度为第 ${cap} 章）。`);
        }
        ctx.focus = { from: validFrom, to: validTo };
        const desc =
          validFrom === null && validTo === null
            ? "已清除章节焦点（不再限制）"
            : `章节焦点已设为 ${validFrom ?? 1}~${validTo ?? cap} 章（不超过当前阅读进度第 ${cap} 章）`;
        return textResult(desc + "。后续检索只返回该区间内的数据。");
      },
    },
  ];
}

function safeParseParticipants(s: string): string[] {
  try {
    const p = JSON.parse(s) as unknown;
    return Array.isArray(p) ? (p as string[]) : [];
  } catch {
    return [];
  }
}
