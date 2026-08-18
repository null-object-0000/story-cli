// Ask 主流程：
//   问题 → Intent → 实体解析 → 结构化上下文（只读结构化库）→ LLM / 模板回答器
// 约束：
//   - 绝不读取 chapters 表原文；
//   - 上下文中的任意记录 chapter <= userChapter（StoryRepo 可见性过滤 + 构造保证）；
//   - 数据不足时明确回答"当前结构化数据不足以可靠回答"，绝不编造。
// 增强：
//   - LLM 模式下，当启发式搜索无命中或分数过低时，给 LLM 一个结构化实体索引做实体消歧（spec §21）。

import { StoryRepo } from "../db/repo.js";
import { StoryConfig } from "../config.js";
import { Intent, classifyIntent, INTENT_NAMES } from "./intent.js";
import { EntityHit, searchEntities, guessProtagonist } from "./search.js";
import { buildContext, StructuredContext } from "./context.js";
import { LlmProvider } from "../llm/types.js";
import { estimateTokens, normalizeText } from "../util.js";

export const INSUFFICIENT_ANSWER = "当前结构化数据不足以可靠回答这个问题。";

export interface AskResult {
  intent: Intent;
  answer: string;
  matchedEntities: string[];
  usedProvider: string;
  tokens?: { input: number; output: number };
}

const FALLBACK_ENTITY_LIMIT = 30;

export const ASK_SYSTEM_PROMPT = `你是一个小说阅读记忆助手。

你只能根据系统提供的 STRUCTURED STORY DATA 回答问题。

你必须遵守以下规则：
1. 你不能使用模型自身关于这部小说的知识。
2. 你不能推测 STRUCTURED STORY DATA 中不存在的信息。
3. 你不能访问小说原文。
4. 如果数据不足，请明确告诉用户："当前结构化数据不足以可靠回答这个问题。"
5. 你绝不能编造任何 STRUCTURED STORY DATA 中不存在的章节号、能力、事实或关系。
6. 用户当前读到第 __USER_CHAPTER__ 章（阅读进度由 STRUCTURED STORY DATA.meta.userChapter 给出），任何超过该章节的信息都不存在于你的知识中，不要提及。

你的任务是帮助用户快速恢复阅读记忆，而不是编写百科全书。
回答应优先告诉用户：
1. 这个人是谁；
2. 为什么用户可能会记得他（有画面感的细节）；
3. 他与主角有什么重要交集；
4. 最近一次重要出现；
5. 必要时再补充其他信息。

回答尽量简洁、具体、有画面感。用中文回答，直接给出答案，不要复述分析过程。`;

const FALLBACK_SYSTEM_PROMPT = `你是一个小说阅读记忆助手。

下面给你一个"实体索引"——这是从小说结构化数据库中提取的实体列表和关系列表，全部来自结构化数据，不包含小说原文。

你的任务：
1. 根据实体索引回答用户问题，索引中不存在的信息**不能**编造。
2. 如果问题不是关于这本书内容的（比如问候），可以简短回应并说明限定范围。
3. 如果问题涉及的人物或信息在索引中不存在，请明确回答："当前结构化数据不足以可靠回答这个问题。"
4. 当前阅读进度到第 __USER_CHAPTER__ 章，不要提及超过该章节的信息。
5. 用中文回答，简洁自然。`;

export async function answerQuestion(opts: {
  repo: StoryRepo;
  cfg: StoryConfig;
  provider: LlmProvider;
  mode: "llm" | "mock";
  question: string;
  /** 流式输出回调（LLM 模式下逐段调用） */
  onToken?: (text: string) => void;
  /** 在开始生成答案前回调（用于先打印 intent/entities 等元信息） */
  onReady?: (info: { intent: string; entities: string[] }) => void;
}): Promise<AskResult> {
  const { repo, cfg, provider, mode, question, onToken, onReady } = opts;
  const userChapter = cfg.userChapter;

  // 1. 能力名命中（优先于一般实体解析）
  const abilityNames: string[] = [];
  for (const a of repo.listAbilities()) {
    if (question.includes(a.name) && a.name.length >= 2) {
      if (!abilityNames.includes(a.name)) abilityNames.push(a.name);
    }
  }

  // 2. Intent（能力问题升级为 ABILITY_LOOKUP）
  let intent: Intent = classifyIntent(question);
  if (abilityNames.length > 0) {
    const specific = /谁的能力|谁的本事|什么时候|哪里来|来源|从谁/.test(question);
    if (
      intent === "ENTITY_SEARCH" ||
      intent === "GENERAL_STRUCTURED_QA" ||
      intent === "RECALL_CHARACTER" ||
      (intent === "LIST_ABILITIES" && specific)
    ) {
      intent = "ABILITY_LOOKUP";
    }
  }

  // 3. 实体解析（仅结构化数据）。能力问题直接由其 Owner 实体命中
  let hits: EntityHit[] = [];
  if (abilityNames.length && intent === "ABILITY_LOOKUP") {
    const ab = repo.findAbilityByName(abilityNames[0])[0];
    if (ab) {
      const owner = repo.getEntity(ab.entity_id);
      if (owner) {
        hits = [{ entity: owner, score: 1e9, matchedVia: `能力「${ab.name}」` }];
      }
    }
  }
  if (hits.length === 0) {
    hits = searchEntities(repo, question, 6);
  }

  // 4. LLM 模式下的实体消歧回退：无命中或分数过低时，给 LLM 结构化实体索引做二次消歧
  const weakHits = hits.length === 0 || hits[0].score < 20;
  if (mode === "llm" && weakHits) {
    onReady?.({ intent: describeIntent(intent), entities: [] });
    const digest = buildEntityIndexDigest(repo, userChapter, FALLBACK_ENTITY_LIMIT);
    const protagonistName = guessProtagonist(repo)?.name ?? null;
    const answer = await llmFallbackAnswer(provider, question, digest, protagonistName, userChapter, onToken);
    return { intent, answer, matchedEntities: [], usedProvider: provider.name };
  }

  // 5. 构造结构化上下文
  const ctx: StructuredContext = buildContext(
    repo,
    { book: cfg.book.trim() || "当前小说", userChapter },
    question,
    intent,
    hits,
    { abilityNames }
  );
  if (abilityNames.length) ctx.abilityId = abilityNames[0];

  // 6. 无任何命中 → 直接不足
  if (ctx.matchedEntities.length === 0) {
    return { intent, answer: INSUFFICIENT_ANSWER, matchedEntities: [], usedProvider: provider.name };
  }

  // 7. 属性性问题且数据不足 → 不足
  if (intent === "GENERAL_STRUCTURED_QA" && isPropertyQuestion(question) && !contextCoversQuestion(question, ctx)) {
    onReady?.({ intent: describeIntent(intent), entities: ctx.matchedEntities.map((c) => c.name) });
    return { intent, answer: INSUFFICIENT_ANSWER, matchedEntities: ctx.matchedEntities.map((c) => c.name), usedProvider: provider.name };
  }

  onReady?.({ intent: describeIntent(intent), entities: ctx.matchedEntities.map((c) => c.name) });
  const answer = mode === "llm"
    ? await llmAnswer(provider, question, ctx, userChapter, onToken)
    : templateAnswer(question, ctx, userChapter);

  const result: AskResult = {
    intent,
    answer,
    matchedEntities: ctx.matchedEntities.map((c) => c.name),
    usedProvider: provider.name,
  };
  if (mode === "llm" && (provider as any)._lastUsage) {
    result.tokens = (provider as any)._lastUsage as { input: number; output: number };
  }
  return result;
}

async function llmAnswer(
  provider: LlmProvider,
  question: string,
  ctx: StructuredContext,
  userChapter: number,
  onToken?: (text: string) => void
): Promise<string> {
  const system = ASK_SYSTEM_PROMPT.replaceAll("__USER_CHAPTER__", String(userChapter));
  const user = `用户问题：${question}\n\nSTRUCTURED STORY DATA（JSON，仅此为数据来源）：\n${JSON.stringify(ctx)}\n\n请根据 STRUCTURED STORY DATA 回答用户问题。`;
  const res = await provider.complete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2, onToken }
  );
  (provider as any)._lastUsage = { input: res.inputTokens, output: res.outputTokens };
  return res.content.trim();
}

async function llmFallbackAnswer(
  provider: LlmProvider,
  question: string,
  digest: string,
  protagonistName: string | null,
  userChapter: number,
  onToken?: (text: string) => void
): Promise<string> {
  const system = FALLBACK_SYSTEM_PROMPT.replaceAll("__USER_CHAPTER__", String(userChapter));
  const user = `问题：${question}\n\n实体索引（结构化数据，仅此为依据，禁止使用模型自身知识）：\n主角：${protagonistName ?? "未知"}\n\n${digest}\n\n请根据实体索引回答用户问题。如果索引中不存在答案，请直接回答："当前结构化数据不足以可靠回答这个问题。"`;
  const res = await provider.complete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { temperature: 0.2, onToken }
  );
  (provider as any)._lastUsage = { input: res.inputTokens, output: res.outputTokens };
  return res.content.trim();
}

export function buildEntityIndexDigest(repo: StoryRepo, _userChapter: number, maxN = 30): string {
  const entities = repo
    .listEntities()
    .sort((a, b) => {
      const ca = repo.firstAndLastAppearance(a.id).count;
      const cb = repo.firstAndLastAppearance(b.id).count;
      return cb - ca;
    })
    .slice(0, maxN);
  const lines: string[] = [];
  for (const e of entities) {
    const aliases = repo.listAliases(e.id).map((a) => a.alias).join("、") || "—";
    const identityFacts = repo
      .listFacts(e.id)
      .filter((f) => ["role", "identity", "occupation", "affiliation", "status"].includes(f.type))
      .slice(0, 3)
      .map((f) => f.value)
      .join("；");
    const { first, count } = repo.firstAndLastAppearance(e.id);
    lines.push(`[${e.type}] ${e.name}（别名：${aliases}）首次第${first ?? "?"}章 出场${count}章 | 身份：${identityFacts || "—"}`);
  }
  const relations = repo.listRelations().slice(0, 80);
  const relLines = relations.map((r) => {
    const f = repo.getEntity(r.from_entity_id)?.name ?? r.from_entity_id;
    const t = repo.getEntity(r.to_entity_id)?.name ?? r.to_entity_id;
    return `${f} --${r.type}--> ${t}：${r.detail ?? ""}（第${r.chapter}章）`;
  });
  return `实体列表（${entities.length} 个）：\n${lines.join("\n")}\n\n关系列表（${relLines.length} 条）：\n${relLines.join("\n")}`;
}

export function recordAskLog(opts: {
  repo: StoryRepo;
  providerName: string;
  question: string;
  answer: string;
  durationMs: number;
  tokens?: { input: number; output: number };
}): void {
  opts.repo.addLlmLog({
    phase: "ask",
    model: opts.providerName,
    range: null,
    inputTokens: opts.tokens?.input ?? estimateTokens(opts.question + "\n" + ASK_SYSTEM_PROMPT),
    outputTokens: opts.tokens?.output ?? estimateTokens(opts.answer),
    durationMs: opts.durationMs,
    success: true,
    retries: 0,
    error: null,
  });
}

// ---------------- 数据充分性判断 ----------------

const STOP_CHARS = new Set("什么怎么为什么是谁吗呢的了和与现在目前一直那个大家给我们自己请想知道记得叫喊做会有没不很太好把被让向从到于之也就都还再又最喜欢爱讨厌帮".split(""));

function bigrams(s: string): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i];
    const b = t[i + 1];
    if (new Set([a, b]).size === 2 && !STOP_CHARS.has(a) && !STOP_CHARS.has(b)) out.add(a + b);
  }
  return out;
}

/** 是否像"属性性问题"（X 最喜欢什么 / X 今年多大） */
export function isPropertyQuestion(q: string): boolean {
  return /最喜欢|最爱|讨厌|喜欢|擅长|是什么|是不是|多大|多少岁|生日|身高|颜色|性格|称号|外号|别名|身份|职业|来自|哪里|为什么|什么时候/.test(q);
}

/** 该问题中"非实体名、非停用词"的特征片段，是否出现在实体卡数据中 */
export function contextCoversQuestion(question: string, ctx: StructuredContext): boolean {
  const qb = bigrams(question);
  if (qb.size === 0) return true;
  const entityBigrams = new Set<string>();
  for (const c of ctx.matchedEntities) {
    for (const b of bigrams(c.name + " " + c.aliases.map((a) => a.alias).join(" "))) entityBigrams.add(b);
  }
  const distinctive = new Set<string>();
  for (const b of qb) if (!entityBigrams.has(b)) distinctive.add(b);
  if (distinctive.size === 0) return true;
  const dataText = ctx.matchedEntities
    .map((c) =>
      [
        ...c.identityFacts.map((f) => f.value),
        ...c.personalityFacts.map((f) => f.value),
        ...c.recallAnchors.map((a) => a.summary),
        ...c.recentEvents.map((e) => e.summary),
        ...c.relations.map((r) => r.detail ?? ""),
      ].join(" ")
    )
    .join(" ") + " " + (ctx.abilities ?? []).map((a) => [a.name, a.summary].join(" ")).join(" ");
  const dataTextNorm = normalizeText(dataText);
  for (const b of distinctive) {
    if (dataTextNorm.includes(b)) return true;
  }
  return false;
}

// ---------------- 模板回答器（离线 / mock 模式）----------------

export function templateAnswer(question: string, ctx: StructuredContext, userChapter: number): string {
  const intent = ctx.intent;
  const ins = () => INSUFFICIENT_ANSWER;

  switch (intent) {
    case "ABILITY_LOOKUP": {
      const abilities = ctx.abilities ?? [];
      const hit = ctx.abilityId ? abilities.find((a) => a.name === ctx.abilityId) : undefined;
      if (!hit) return ins();
      const parts = [`【${hit.name}】—— ${hit.entityName} 的能力。`];
      if (hit.system || hit.path) parts.push(`体系：${[hit.system, hit.path].filter(Boolean).join("·")}${hit.level ? `（${hit.level}）` : ""}`);
      if (hit.sourceEntity) parts.push(`来源：${hit.sourceEntity}`);
      if (hit.acquiredChapter) parts.push(`获得章节：第${hit.acquiredChapter}章`);
      if (hit.summary) parts.push(`说明：${hit.summary}`);
      return parts.join("\n");
    }
    case "LIST_ABILITIES": {
      const card = ctx.matchedEntities[0];
      if (!card) return ins();
      const abilities = ctx.abilities ?? [];
      if (abilities.length === 0) return ins();
      const lines = abilities.map((a, i) => {
        const sys = [a.system, a.path].filter(Boolean).join("·");
        const lv = a.level ? `（${a.level}）` : "";
        const acq = a.acquiredChapter ? `第${a.acquiredChapter}章获得` : `第${a.chapter}章提及`;
        const src = a.sourceEntity ? `，来自${a.sourceEntity}` : "";
        return `${i + 1}. ${a.name}${lv}${sys ? `（${sys}）` : ""} · ${acq}${src}${a.summary ? ` —— ${a.summary}` : ""}`;
      });
      return `截至第${userChapter}章，${card.name}拥有的能力（来自结构化数据）：\n${lines.join("\n")}`;
    }
    case "CHARACTER_RELATION": {
      const a = ctx.matchedEntities[0];
      const b = ctx.matchedEntities[1];
      if (!a || !b) return ins();
      const rels = [...a.relations.filter((r) => r.with === b.name), ...b.relations.filter((r) => r.with === a.name)];
      if (rels.length === 0) return `当前结构化数据中没有「${a.name}」与「${b.name}」之间的关系记录。`;
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const r of rels) {
        const key = `${r.type}|${r.detail ?? ""}|${r.chapter}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`· ${r.detail ?? `${a.name}与${b.name}${r.type}`}（第${r.chapter}章）`);
      }
      return `「${a.name}」与「${b.name}」的关系（来自结构化数据）：\n${lines.join("\n")}`;
    }
    case "LAST_APPEARANCE": {
      const card = ctx.matchedEntities[0];
      if (!card) return ins();
      if (card.firstSeenChapter === null) return ins();
      const last = card.lastSeenChapter ?? card.firstSeenChapter;
      const gap = userChapter - last;
      const rows = [`首次出现：第${card.firstSeenChapter}章`, `最近出现：第${last}章`, `出现章节数：${card.appearanceChapterCount}`];
      if (gap > 0) rows.push(`距当前阅读进度（第${userChapter}章）：${gap}章`);
      return `${card.name}（来自结构化数据）：\n${rows.join("\n")}`;
    }
    case "CHARACTER_HISTORY": {
      const card = ctx.matchedEntities[0];
      if (!card) return ins();
      const anchors = card.recallAnchors.map((a) => `第${a.chapter}章 · ${a.summary}`);
      const events = card.recentEvents.slice().reverse().map((e) => `第${e.chapter}章 · ${e.summary}`);
      const timeline = [...anchors, ...events].filter((v, i, arr) => arr.indexOf(v) === i);
      if (!timeline.length) return ins();
      return `${card.name}的经历（来自结构化数据）：\n${timeline.join("\n")}`;
    }
    case "ENTITY_SEARCH": {
      const cands = ctx.candidates ?? ctx.matchedEntities;
      if (!cands.length) return ins();
      const lines = cands.map((c, i) => {
        const idFacts = c.identityFacts.map((f) => f.value).slice(0, 2).join("；");
        const firstAnchor = c.recallAnchors[0];
        const via = firstAnchor ? `，你可能记得ta因为："${firstAnchor.summary}"（第${firstAnchor.chapter}章）` : "";
        return `${i + 1}. ${c.name}（${idFacts || "身份待补充"}）${via}`;
      });
      return `根据结构化数据，最可能匹配的人物：\n${lines.join("\n")}`;
    }
    case "RECALL_CHARACTER":
    case "GENERAL_STRUCTURED_QA":
    default: {
      const card = ctx.matchedEntities[0];
      if (!card) return ins();
      const idFacts = card.identityFacts;
      const who = idFacts.length
        ? `${card.name}${idFacts[0].value ? "是" + idFacts.map((f) => f.value).join("；") : ""}`
        : card.name;
      const parts = [who];
      const anchors = card.recallAnchors.slice(0, 4);
      if (anchors.length) {
        parts.push("你可能记得ta因为：");
        for (const a of anchors) parts.push(`· 第${a.chapter}章：${a.summary}`);
      }
      const relWithPro = card.relations.filter((r) => r.protagonist).slice(0, 3);
      if (relWithPro.length) {
        parts.push("与主角的重要交集：");
        for (const r of relWithPro) parts.push(`· ${r.detail ?? r.type}（第${r.chapter}章）`);
      }
      if (card.lastSeenChapter) {
        parts.push(`最近一次出现：第${card.lastSeenChapter}章。`);
      }
      return parts.join("\n");
    }
  }
}

export function describeIntent(intent: Intent): string {
  return INTENT_NAMES[intent];
}