// Build Pipeline：分批次 LLM 抽取 → schema 校验 → 入库 → 断点续跑 → 日志
// 硬约束：任何抽取/入库行为只允许落在 [1, maxChapter] 范围内。

import { StoryRepo } from "../db/repo.js";
import { LlmProvider, ChapterSlice, ExtractionInput } from "../llm/types.js";
import { validateExtractionOutput, ValidationError, ExtractionBundle } from "./validation.js";
import { aliasClashToDuplicate } from "./resolution.js";
import { log, warn } from "../logger.js";
import { clampInt, estimateTokens, sleep } from "../util.js";

export interface BuildOptions {
  fromChapter?: number;
  toChapter?: number;
  force?: boolean;
  batchSize?: number;
  retries?: number;
  maxChapter: number;
  concurrency?: number;
  /** 进度回调（每批完成时触发，用于 TUI 实时更新） */
  onProgress?: (progress: BuildProgress) => void;
}

export interface BuildProgress {
  /** 当前批次区间（如 "1-5"；status=running 时是刚开始的批次） */
  range: string;
  /** running=开始处理（LLM 调用中），done/failed=批次结束 */
  status: "running" | "done" | "failed";
  /** 当前批次结果（running 时为零值） */
  counts: BatchResult;
  /** 已结束（done+failed）的批次数 */
  doneCount: number;
  /** 总批次数 */
  totalCount: number;
  /** 失败批次数 */
  failedCount: number;
  /** 当前正在处理的批次（用于实时显示） */
  running: string[];
}

export interface BatchResult {
  range: string;
  status: "done" | "failed";
  newEntities: number;
  entityUpdates: number;
  aliases: number;
  facts: number;
  relations: number;
  abilities: number;
  events: number;
  memoryAnchors: number;
  duplicates: number;
}

export async function runBuild(repo: StoryRepo, provider: LlmProvider, opts: BuildOptions): Promise<{
  processed: BatchResult[];
  skipped: number;
  failed: number;
}> {
  const maxChapter = opts.maxChapter;
  const batchSize = Math.max(1, opts.batchSize ?? 5);
  const retries = Math.max(0, opts.retries ?? 2);

  const chapterCount = repo.countChapters();
  if (chapterCount === 0) {
    throw new Error("chapters 表为空，请先运行：story import <小说文件> --to-chapter <N>");
  }
  const dbMax = repo.maxChapterInDb() ?? 0;
  const toChapter = clampInt(opts.toChapter ?? dbMax, 1, Math.min(dbMax, maxChapter));
  const fromChapter = clampInt(opts.fromChapter ?? 1, 1, toChapter);

  // 生成批次
  const ranges: { start: number; end: number }[] = [];
  for (let s = fromChapter; s <= toChapter; s += batchSize) {
    ranges.push({ start: s, end: Math.min(s + batchSize - 1, toChapter) });
  }

  // 断点续跑：跳过已完成批次（除非 --force）
  const pending: { start: number; end: number }[] = [];
  let skipped = 0;
  for (const r of ranges) {
    const key = `${r.start}-${r.end}`;
    const state = repo.getBatch(key);
    if (!opts.force && state?.status === "done") {
      skipped++;
      continue;
    }
    pending.push(r);
  }
  if (!opts.force && skipped > 0) {
    log(`跳过已完成的批次：${skipped} 个（使用 --force 可重新抽取）`);
  }

  const processed: BatchResult[] = [];
  let failed = 0;
  let doneCount = 0;
  const totalBatches = pending.length;
  /** 正在处理的批次（running 状态，实时显示） */
  const running: string[] = [];
  const zeroResult = (range: string, status: "done" | "failed"): BatchResult => ({ range, status, ...zeroCounts() });
  const emitProgress = (range: string, status: BuildProgress["status"], counts: BatchResult): void => {
    if (status === "done") doneCount++;
    else if (status === "failed") failed++;
    opts.onProgress?.({
      range,
      status,
      counts,
      doneCount,
      totalCount: totalBatches,
      failedCount: failed,
      running: [...running],
    });
  };

  // 单批处理
  async function processBatch(r: { start: number; end: number }): Promise<void> {
    const key = `${r.start}-${r.end}`;
    running.push(key);
    emitProgress(key, "running", zeroResult(key, "done"));
    log(`[${key}] extracting...`);
    const texts: ChapterSlice[] = [];
    for (let c = r.start; c <= r.end; c++) {
      const text = repo.getChapterText(c);
      if (text === null) continue;
      const meta = repo.listChapterMeta().find((m) => m.chapter === c);
      texts.push({ chapter: c, title: meta?.title ?? "", text });
    }
    if (texts.length === 0) {
      warn(`[${key}] 无章节文本，跳过`);
      const zero = zeroCounts();
      const br: BatchResult = { range: key, status: "failed", ...zero };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      emitProgress(key, "failed", br);
      return;
    }

    // 已有实体索引
    const knownEntities = repo
      .listEntities()
      .map((e) => ({ id: e.id, name: e.name, type: e.type }));
    const aliases = repo.listAliases().map((a) => ({ alias: a.alias, entityId: a.entity_id, entityName: repo.getEntity(a.entity_id)?.name ?? "" }));

    // 滚动摘要
    const previousSummary = rollPreviousSummary(repo, r.start);

    const input: ExtractionInput = {
      range: key,
      startChapter: r.start,
      endChapter: r.end,
      texts,
      knownEntities,
      aliases,
      previousSummary,
      maxChapter,
    };

    // 调用 + 校验 + 重试
    let bundle: ExtractionBundle | null = null;
    let lastError = "";
    const t0 = Date.now();
    let attempt = 0;
    for (; attempt <= retries; attempt++) {
      if (attempt > 0) {
        log(`  [${key}] 校验失败，第 ${attempt} 次重试...`);
        await sleep(500 * attempt);
      }
      try {
        const raw = await provider.extract(input);
        bundle = validateExtractionOutput(raw, maxChapter);
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt >= retries) break;
      }
    }
    const durationMs = Date.now() - t0;
    const success = bundle !== null;

    if (!bundle) {
      warn(`[${key}] 抽取失败（重试 ${retries} 次后放弃）：${lastError}`);
      repo.addLlmLog({ phase: "extract", model: provider.name, range: key, inputTokens: 0, outputTokens: 0, durationMs, success: false, retries: attempt, error: lastError });
      repo.markBatch(key, r.start, r.end, "failed", zeroCounts(), null);
      const br: BatchResult = { range: key, status: "failed", ...zeroCounts() };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      emitProgress(key, "failed", br);
      return;
    }

    // ---- 入库（全同步，无 await，线程安全） ----
    const counts = { newEntities: 0, aliases: 0, facts: 0, relations: 0, abilities: 0, events: 0, memoryAnchors: 0, duplicates: 0 };
    let entityUpdates = 0;

    try {
      repo.db.exec("BEGIN");
      const createdThisBatch = new Set<string>();
      for (const e of bundle.newEntities) {
        const r1 = repo.upsertEntity(e.type as any, e.name, e.firstSeenChapter);
        if (r1.created) { counts.newEntities++; createdThisBatch.add(r1.id); }
        else entityUpdates++;
      }
      const ensureEntity = (name: string, chapter: number): string | null => {
        const ex = repo.findEntityByName(name);
        if (ex) {
          repo.upsertEntity(ex.type, name, chapter);
          return ex.id;
        }
        const r1 = repo.upsertEntity("character", name, chapter);
        if (r1.created) { counts.newEntities++; createdThisBatch.add(r1.id); }
        return r1.id;
      };
      for (const a of bundle.aliases) {
        const id = ensureEntity(a.entityName, a.fromChapter);
        if (!id) continue;
        const status = repo.addAlias(id, a.alias, a.fromChapter);
        if (status === "added") counts.aliases++;
        else if (status === "clash") {
          const other = repo.findByAlias(a.alias);
          if (other) aliasClashToDuplicate(repo, a.alias, id, other.id);
        }
      }
      for (const f of bundle.facts) {
        const id = ensureEntity(f.entityName, f.chapter);
        if (id && repo.addFact(id, f.type, f.value, f.chapter, f.confidence)) counts.facts++;
      }
      for (const rel of bundle.relations) {
        const from = ensureEntity(rel.fromName, rel.chapter);
        const to = ensureEntity(rel.toName, rel.chapter);
        if (from && to && from !== to && repo.addRelation(from, to, rel.type, rel.detail, rel.chapter, rel.confidence)) counts.relations++;
      }
      for (const ab of bundle.abilities) {
        const id = ensureEntity(ab.entityName, ab.chapter);
        if (id && repo.addAbility(id, {
          name: ab.name, category: ab.category, system: ab.system, path: ab.path, level: ab.level,
          source_entity: ab.sourceEntity, acquired_chapter: ab.acquiredChapter, summary: ab.summary,
          chapter: ab.chapter, confidence: 0.85,
        })) counts.abilities++;
      }
      for (const e of bundle.events) {
        const partIds = e.participantNames.map((n) => ensureEntity(n, e.chapter)).filter(Boolean) as string[];
        if (repo.addEvent(e.chapter, partIds, e.type, e.summary, e.importance)) counts.events++;
      }
      for (const m of bundle.memoryAnchors) {
        const id = ensureEntity(m.entityName, m.chapter);
        if (id && repo.addMemoryAnchor(id, m.chapter, m.summary, m.importance, m.memorability, m.protagonistRelevance)) counts.memoryAnchors++;
      }
      for (const d of bundle.possibleDuplicates) {
        const aId = repo.findEntityByName(d.entityA)?.id;
        const bId = repo.findEntityByName(d.entityB)?.id;
        if (aId && bId && aId !== bId) {
          const [low, high] = [aId, bId].sort();
          if (repo.addPossibleDuplicate(low, high, d.reason)) counts.duplicates++;
        }
      }
      for (const c of bundle.conflicts) {
        const eId = c.entityName ? repo.findEntityByName(c.entityName)?.id ?? null : null;
        repo.addConflict(c.kind, eId, c.detail, c.chapterA, c.chapterB);
      }
      countAppearances(repo, texts);
      repo.db.exec("COMMIT");
    } catch (e) {
      repo.db.exec("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[${key}] 入库失败（事务回滚）：${msg}`);
      repo.addLlmLog({ phase: "extract", model: provider.name, range: key, inputTokens: 0, outputTokens: 0, durationMs, success: false, retries: attempt, error: msg });
      repo.markBatch(key, r.start, r.end, "failed", zeroCounts(), null);
      const br: BatchResult = { range: key, status: "failed", ...zeroCounts() };
      processed.push(br);
      running.splice(running.indexOf(key), 1);
      emitProgress(key, "failed", br);
      return;
    }

    const inputTokens = estimateTokens(JSON.stringify(input));
    const outputTokens = estimateTokens(JSON.stringify(bundle));
    repo.addLlmLog({ phase: "extract", model: provider.name, range: key, inputTokens, outputTokens, durationMs, success: true, retries: attempt });
    repo.markBatch(key, r.start, r.end, "done", counts, bundle.batchSummary);

    log(`  new entities: ${counts.newEntities}`);
    if (entityUpdates > 0) log(`  entity updates: ${entityUpdates}`);
    if (counts.aliases) log(`  aliases: ${counts.aliases}`);
    if (counts.facts) log(`  facts: ${counts.facts}`);
    if (counts.relations) log(`  relations: ${counts.relations}`);
    if (counts.abilities) log(`  abilities: ${counts.abilities}`);
    if (counts.events) log(`  events: ${counts.events}`);
    if (counts.memoryAnchors) log(`  memory anchors: ${counts.memoryAnchors}`);
    if (counts.duplicates) log(`  possible duplicates: ${counts.duplicates}`);

    const br: BatchResult = { range: key, status: "done", ...counts, entityUpdates };
    processed.push(br);
    running.splice(running.indexOf(key), 1);
    emitProgress(key, "done", br);
  }

  // 并发执行：最多 N 个 worker 从 pending 队列取任务
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  if (totalBatches === 0) {
    // 没有待处理批次，也上报一次空进度（UI 立即显示"无待处理"）
    opts.onProgress?.({ range: "", status: "done", counts: zeroResult("", "done"), doneCount: 0, totalCount: 0, failedCount: 0, running: [] });
  }
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const r = queue.shift()!;
      await processBatch(r);
    }
  });
  await Promise.all(workers);

  return { processed, skipped, failed };
}

function zeroCounts() {
  return { newEntities: 0, entityUpdates: 0, aliases: 0, facts: 0, relations: 0, abilities: 0, events: 0, memoryAnchors: 0, duplicates: 0 };
}

/** 取 startChapter 之前的最近一个已完成批次的摘要 */
function rollPreviousSummary(repo: StoryRepo, startChapter: number): string | null {
  const rows = repo
    .db
    .prepare("SELECT range, summary FROM batch_state WHERE status='done' AND end_chapter < ? ORDER BY end_chapter DESC LIMIT 1")
    .all(startChapter) as { range: string; summary: string | null }[];
  return rows.length ? rows[0].summary : null;
}

/** 出场记录：对给定章节文本扫描所有实体名+别名 */
export function countAppearances(repo: StoryRepo, texts: ChapterSlice[]): void {
  const entities = repo.listEntities();
  const aliasMap = new Map<string, string>(); // alias → entityId
  for (const a of repo.listAliases()) aliasMap.set(a.alias, a.entity_id);
  for (const t of texts) {
    for (const e of entities) {
      let mentions = 0;
      mentions += countOccurrences(t.text, e.name);
      for (const [alias, eid] of aliasMap) {
        if (eid === e.id) mentions += countOccurrences(t.text, alias);
      }
      if (mentions > 0) repo.recordAppearance(e.id, t.chapter, mentions);
    }
  }
}

function countOccurrences(text: string, needle: string): number {
  if (!needle || needle.length === 0) return 0;
  let n = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return n;
}