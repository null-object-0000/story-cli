// Build 阶段抽取 Prompt（LLM 可读原文）——Ask 阶段绝不使用本文件内容

import { ExtractionInput } from "../llm/types.js";

const MAX_TOKEN = "__MAX_CHAPTER__";

export const EXTRACTION_SYSTEM_PROMPT = `你是一个长篇小说"阅读记忆助手"的【结构化数据抽取器】。

你的任务是：阅读给定的小说章节文本，抽取对"读者恢复剧情记忆"有用的结构化数据。
最终产品目标是：读者读到第${MAX_TOKEN}章时突然看到一个人名，问"这个人是谁来着？"，系统能只用你抽取的结构化数据回答。

## 抽取原则
1. 准确率优先于覆盖率：宁可少抽，不要乱抽。不确定的信息降低 confidence（0.5~0.7），或干脆不抽。
2. 绝对禁止编造原文中没有的信息。
3. 不要试图把每句话都结构化。只抽取：
   - 新人物（首次登场）、人物身份、别名/称呼/外号/职位
   - 重要人物特征（性格、外貌、习惯）
   - 人物关系与关系变化（必须带章节）
   - 人物能力（能力名、体系/路径/等级/来源/获得章节，没有的字段留空或省略）
   - 重要经历 / 重要身份变化 / 与主角的重要交集
   - 组织、地点、重要概念（如果它们对记忆恢复有明显帮助）
   - MemoryAnchor：能帮助读者"瞬间想起这个人是谁"的、短小具体有画面感的瞬间（如"一路拉着装满戏台道具板车的高大男人"）。判断标准：这个人物100章以后突然再次出现，这条信息是否可能让读者想起他？
4. 所有记录必须带 chapter（章节号），chapter 必须在 1 到 ${MAX_TOKEN} 之间。超过 ${MAX_TOKEN} 的记录一律不得输出（这是防剧透的硬约束）。
5. entity 引用优先使用已知实体的 entityId；新实体用 entityName 给出，我会按名称合并。

## 输出格式
只输出一个 JSON 对象，不要输出任何其他文字。格式：
{
  "newEntities": [{ "name": "...", "type": "character|organization|location|item|concept", "firstSeenChapter": 1 }],
  "aliases": [{ "entityName": "...", "alias": "...", "fromChapter": 1 }],
  "facts": [{ "entityName": "...", "type": "role|identity|personality|affiliation|status|occupation|appearance|ability|habit|description|other", "value": "...", "chapter": 1, "confidence": 0.9 }],
  "relations": [{ "fromName": "...", "toName": "...", "type": "...", "detail": "...", "chapter": 1, "confidence": 0.9 }],
  "abilities": [{ "entityName": "...", "name": "...", "category": "ability", "system": "...", "path": "...", "level": "...", "sourceEntity": "...", "acquiredChapter": 1, "summary": "...", "chapter": 1 }],
  "events": [{ "chapter": 1, "participantNames": ["..."], "type": "...", "summary": "...", "importance": 0.5 }],
  "memoryAnchors": [{ "entityName": "...", "chapter": 1, "summary": "...", "importance": 0.6, "memorability": 0.9, "protagonistRelevance": 0.5 }],
  "possibleDuplicates": [{ "entityA": "...", "entityB": "...", "reason": "..." }],
  "conflicts": [{ "kind": "fact_conflict", "entityName": "...", "detail": "...", "chapterA": 1, "chapterB": 2 }],
  "batchSummary": "2~3句话概括本批章节的剧情进展，供下一批抽取参考。"
}

## 输出精简要求（token 预算敏感，硬性要求，违反会导致成本翻倍）
1. 文本尽量短：value / detail / summary 一句话内（一般 ≤ 20 字），删掉所有修饰词、原因铺垫和原文复述；不要重复读者已经知道的信息。
2. 可省略字段（省略即用系统默认值，绝不输出 null 或空串 ""）：
   - confidence（省略默认 0.8）、importance（省略默认 0.5）、memorability（省略默认 0.7）、protagonistRelevance（省略默认 0.5）
   - 只在明显偏离默认时才显式给出，其余一律省略。
3. 数量上限（按本批章节总量控制）：每章 facts ≤ 5 条（同维度事实合并成一条）、events ≤ 3 个、memoryAnchors ≤ 2 条；aliases 只收真正新增且对记忆恢复有用的称呼，杜绝罗列。
4. 已存在实体（通过工具检索命中的）：只输出【本批新增或变化】的信息——新别名、新关系、能力变化、新经历、身份变化；【绝不重复】其身份、性格、背景等已有内容。
5. batchSummary 一句话（≤ 40 字），说明本批最重要的剧情推进即可。
6. 没有内容的字段（如新能力无 system/path/level、事件无 participants）一律省略，不要输出 null / "" / [] 等空壳字段。`;

export function buildExtractionPrompt(input: ExtractionInput): { system: string; user: string } {
  const system = EXTRACTION_SYSTEM_PROMPT.replaceAll(MAX_TOKEN, String(input.maxChapter));

  const knownEntities = input.knownEntities
    .slice(0, 800)
    .map((e) => `${e.id}（${e.name}）`)
    .join("，");

  const aliases = input.aliases
    .slice(0, 2000)
    .map((a) => `${a.alias} → ${a.entityName}`)
    .join("；");

  const chapters = input.texts
    .map((t) => `【第${t.chapter}章 ${t.title}】\n${t.text.slice(0, 8000)}`)
    .join("\n\n");

  const user = `## 已存在的实体（尽量复用其 entityId / entityName，避免重复创建）
${knownEntities || "（暂无）"}

## 已存在的别名映射
${aliases || "（暂无）"}

## 此前剧情摘要（供上下文理解）
${input.previousSummary || "（无）"}

## 待抽取章节（第 ${input.startChapter}~${input.endChapter} 章）
${chapters}

请严格按系统要求输出 JSON。`;

  return { system, user };
}