// 抽取输出的 runtime schema 校验。校验失败 → 重试；重试仍失败 → 整批跳过并记日志（绝不脏数据入库）。

import { ENTITY_TYPES } from "../db/repo.js";

export const FACT_TYPES = new Set([
  "role", "identity", "personality", "affiliation", "status", "occupation",
  "appearance", "ability", "habit", "description", "other",
]);

export interface ExtractionBundle {
  newEntities: { name: string; type: string; firstSeenChapter: number }[];
  aliases: { entityName: string; alias: string; fromChapter: number }[];
  facts: { entityName: string; type: string; value: string; chapter: number; confidence: number }[];
  relations: { fromName: string; toName: string; type: string; detail: string | null; chapter: number; confidence: number }[];
  abilities: {
    entityName: string; name: string; category: string | null; system: string | null; path: string | null;
    level: string | null; sourceEntity: string | null; acquiredChapter: number | null; summary: string | null; chapter: number;
  }[];
  events: { chapter: number; participantNames: string[]; type: string; summary: string; importance: number }[];
  memoryAnchors: {
    entityName: string; chapter: number; summary: string;
    importance: number; memorability: number; protagonistRelevance: number;
  }[];
  possibleDuplicates: { entityA: string; entityB: string; reason: string }[];
  conflicts: { kind: string; entityName: string | null; detail: string; chapterA: number | null; chapterB: number | null }[];
  batchSummary: string | null;
}

export class ValidationError extends Error {}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function checkChapter(v: unknown, maxChapter: number, label: string): number {
  const n = num(v);
  if (n === null || !Number.isInteger(n) || n < 1 || n > maxChapter) {
    throw new ValidationError(`${label} 章节号非法：${JSON.stringify(v)}（必须在 1..${maxChapter}）`);
  }
  return n;
}

function checkConfidence(v: unknown, label: string): number {
  const n = num(v);
  if (n === null || n < 0 || n > 1) {
    throw new ValidationError(`${label} confidence 非法：${JSON.stringify(v)}`);
  }
  return n;
}

export function validateExtractionOutput(raw: unknown, maxChapter: number): ExtractionBundle {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("输出必须是 JSON 对象");
  }
  const o = raw as Record<string, unknown>;
  const arr = (k: string): unknown[] => (Array.isArray(o[k]) ? (o[k] as unknown[]) : []);

  // entity refs in this batch（新实体名）
  const newNames = new Set<string>();
  const newEntities: ExtractionBundle["newEntities"] = [];
  for (const e of arr("newEntities")) {
    if (typeof e !== "object" || e === null) throw new ValidationError("newEntities 元素必须是对象");
    const name = str((e as any).name);
    const type = str((e as any).type);
    if (!name) throw new ValidationError("newEntities.name 缺失");
    if (!type || !ENTITY_TYPES.includes(type as any)) throw new ValidationError(`newEntities.type 非法：${type}`);
    const chapter = checkChapter((e as any).firstSeenChapter, maxChapter, `实体 ${name}`);
    newNames.add(name);
    newEntities.push({ name, type, firstSeenChapter: chapter });
  }

  const aliases: ExtractionBundle["aliases"] = [];
  for (const a of arr("aliases")) {
    if (typeof a !== "object" || a === null) throw new ValidationError("aliases 元素必须是对象");
    const entityName = str((a as any).entityName);
    const alias = str((a as any).alias);
    if (!entityName) throw new ValidationError("aliases.entityName 缺失");
    if (!alias) throw new ValidationError("aliases.alias 缺失");
    const chapter = checkChapter((a as any).fromChapter, maxChapter, `别名 ${alias}`);
    aliases.push({ entityName, alias, fromChapter: chapter });
  }

  const facts: ExtractionBundle["facts"] = [];
  for (const f of arr("facts")) {
    if (typeof f !== "object" || f === null) throw new ValidationError("facts 元素必须是对象");
    const entityName = str((f as any).entityName);
    const type = str((f as any).type);
    const value = str((f as any).value);
    if (!entityName) throw new ValidationError("facts.entityName 缺失");
    if (!type) throw new ValidationError("facts.type 缺失");
    if (!value) throw new ValidationError("facts.value 缺失");
    const chapter = checkChapter((f as any).chapter, maxChapter, `事实 ${value.slice(0, 20)}`);
    const confidence = checkConfidence((f as any).confidence ?? 0.8, `事实 ${value.slice(0, 20)}`);
    facts.push({ entityName, type, value, chapter, confidence });
    if (value.length > 500) throw new ValidationError(`事实描述过长：${value.slice(0, 30)}...`);
  }

  const relations: ExtractionBundle["relations"] = [];
  for (const r of arr("relations")) {
    if (typeof r !== "object" || r === null) throw new ValidationError("relations 元素必须是对象");
    const fromName = str((r as any).fromName);
    const toName = str((r as any).toName);
    const type = str((r as any).type);
    if (!fromName || !toName) throw new ValidationError("relations fromName/toName 缺失");
    if (!type) throw new ValidationError("relations.type 缺失");
    if (fromName === toName) throw new ValidationError(`关系两端不能相同：${fromName}`);
    const chapter = checkChapter((r as any).chapter, maxChapter, `关系 ${fromName}-${toName}`);
    const confidence = checkConfidence((r as any).confidence ?? 0.8, `关系 ${fromName}-${toName}`);
    relations.push({ fromName, toName, type, detail: str((r as any).detail), chapter, confidence });
  }

  const abilities: ExtractionBundle["abilities"] = [];
  for (const ab of arr("abilities")) {
    if (typeof ab !== "object" || ab === null) throw new ValidationError("abilities 元素必须是对象");
    const entityName = str((ab as any).entityName);
    const name = str((ab as any).name);
    if (!entityName) throw new ValidationError("abilities.entityName 缺失");
    if (!name) throw new ValidationError("abilities.name 缺失");
    const chapter = checkChapter((ab as any).chapter, maxChapter, `能力 ${name}`);
    let acquired: number | null = null;
    const ac = (ab as any).acquiredChapter;
    if (ac !== null && ac !== undefined && ac !== "") acquired = checkChapter(ac, maxChapter, `能力 ${name} 获得章节`);
    abilities.push({
      entityName, name,
      category: str((ab as any).category),
      system: str((ab as any).system),
      path: str((ab as any).path),
      level: (ab as any).level === null || (ab as any).level === undefined ? null : String((ab as any).level),
      sourceEntity: str((ab as any).sourceEntity),
      acquiredChapter: acquired,
      summary: str((ab as any).summary),
      chapter,
    });
  }

  const events: ExtractionBundle["events"] = [];
  for (const e of arr("events")) {
    if (typeof e !== "object" || e === null) throw new ValidationError("events 元素必须是对象");
    const chapter = checkChapter((e as any).chapter, maxChapter, `事件`);
    const summary = str((e as any).summary);
    if (!summary) throw new ValidationError("events.summary 缺失");
    const ps = (e as any).participantNames;
    if (ps !== undefined && ps !== null && !Array.isArray(ps)) throw new ValidationError("events.participantNames 必须是数组");
    const names = Array.isArray(ps) ? (ps as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
    const importn = num((e as any).importance) ?? 0.5;
    events.push({ chapter, participantNames: names, type: str((e as any).type) ?? "other", summary, importance: Math.min(1, Math.max(0, importn)) });
  }

  const memoryAnchors: ExtractionBundle["memoryAnchors"] = [];
  for (const m of arr("memoryAnchors")) {
    if (typeof m !== "object" || m === null) throw new ValidationError("memoryAnchors 元素必须是对象");
    const entityName = str((m as any).entityName);
    const summary = str((m as any).summary);
    if (!entityName) throw new ValidationError("memoryAnchors.entityName 缺失");
    if (!summary) throw new ValidationError("memoryAnchors.summary 缺失");
    const chapter = checkChapter((m as any).chapter, maxChapter, `记忆锚点 ${summary.slice(0, 16)}`);
    const imp = num((m as any).importance) ?? 0.5;
    const mem = num((m as any).memorability) ?? 0.7;
    const pr = num((m as any).protagonistRelevance) ?? 0.5;
    memoryAnchors.push({
      entityName, chapter, summary,
      importance: Math.min(1, Math.max(0, imp)),
      memorability: Math.min(1, Math.max(0, mem)),
      protagonistRelevance: Math.min(1, Math.max(0, pr)),
    });
  }

  const possibleDuplicates: ExtractionBundle["possibleDuplicates"] = [];
  for (const d of arr("possibleDuplicates")) {
    if (typeof d !== "object" || d === null) continue;
    const a = str((d as any).entityA);
    const b = str((d as any).entityB);
    if (a && b && a !== b) {
      possibleDuplicates.push({ entityA: a, entityB: b, reason: str((d as any).reason) ?? "LLM 建议" });
    }
  }

  const conflicts: ExtractionBundle["conflicts"] = [];
  for (const c of arr("conflicts")) {
    if (typeof c !== "object" || c === null) continue;
    const kind = str((c as any).kind) ?? "other";
    const detail = str((c as any).detail);
    if (!detail) continue;
    const a = num((c as any).chapterA);
    const b = num((c as any).chapterB);
    conflicts.push({
      kind,
      entityName: str((c as any).entityName),
      detail,
      chapterA: a !== null && a >= 1 && a <= maxChapter ? a : null,
      chapterB: b !== null && b >= 1 && b <= maxChapter ? b : null,
    });
  }

  const summary = str(o.batchSummary);

  return {
    newEntities, aliases, facts, relations, abilities, events, memoryAnchors,
    possibleDuplicates, conflicts, batchSummary: summary,
  };
}