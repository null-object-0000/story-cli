// story stats：数据量 / LLM 成本 / 构建性能 / 完整性校验（合并了原 story validate）
// 严重完整性错误 → exit code 1（供脚本/自动化判断）

import { loadConfig, dbPath, resolveLlmPrices, costEstimate } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { log, warn, section } from "../../logger.js";
import { pad as padFlat } from "../../util.js";

interface IntegrityIssues {
  errors: string[];
  warnings: string[];
  chapters: number;
  availableThrough: number | null;
  builtThrough: number | null;
}

/** 完整性校验（原 story validate 的全部检查逻辑） */
function checkIntegrity(repo: StoryRepo): IntegrityIssues {
  const errors: string[] = [];
  const warnings: string[] = [];
  const chapters = repo.countChapters();
  if (chapters === 0) errors.push("chapters 表为空：请先 story import");
  const availableThrough = repo.availableThrough();
  const builtThrough = repo.builtThrough();

  // 孤儿别名
  const orphanAliases = (repo.db.prepare(
    "SELECT COUNT(*) AS n FROM aliases a LEFT JOIN entities e ON e.id=a.entity_id WHERE e.id IS NULL"
  ).get() as { n: number }).n;
  if (orphanAliases > 0) errors.push(`孤儿 Alias：${orphanAliases} 条（引用不存在的实体）`);

  // 引用不存在的实体
  const dangling = (table: string, col: string) =>
    (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table} x LEFT JOIN entities e ON e.id=x.${col} WHERE e.id IS NULL`).get() as { n: number }).n;
  for (const [t, c] of [
    ["facts", "entity_id"],
    ["abilities", "entity_id"],
    ["memory_anchors", "entity_id"],
    ["entity_appearances", "entity_id"],
  ] as [string, string][]) {
    const n = dangling(t, c);
    if (n > 0) errors.push(`${t}.${c} 有 ${n} 条引用不存在的实体`);
  }
  const relMissing = (repo.db.prepare(
    `SELECT COUNT(*) AS n FROM relations r WHERE r.from_entity_id NOT IN (SELECT id FROM entities) OR r.to_entity_id NOT IN (SELECT id FROM entities)`
  ).get() as { n: number }).n;
  if (relMissing > 0) errors.push(`relations 有 ${relMissing} 条端点不存在的记录`);
  const selfLoop = (repo.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE from_entity_id=to_entity_id").get() as { n: number }).n;
  if (selfLoop > 0) errors.push(`relations 有 ${selfLoop} 条自环记录`);

  // firstSeen 异常
  const badFirst = (repo.db.prepare(
    "SELECT COUNT(*) AS n FROM entities WHERE first_seen_chapter IS NULL OR first_seen_chapter < 1"
  ).get() as { n: number }).n;
  if (badFirst > 0) errors.push(`${badFirst} 个实体缺少有效的 first_seen_chapter`);

  // 重复实体名
  const dupNames = (repo.db.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT type,name FROM entities GROUP BY type,name HAVING COUNT(*)>1)"
  ).get() as { n: number }).n;
  if (dupNames > 0) errors.push(`${dupNames} 组重复名称实体（同类型同名）`);

  // 重要数据缺章
  const noChapter = (repo.db.prepare(
    `SELECT COUNT(*) AS n FROM facts WHERE chapter IS NULL OR chapter<1`
  ).get() as { n: number }).n;
  if (noChapter > 0) errors.push(`${noChapter} 条事实缺少有效章节号`);

  // 没有出场记录的实体
  const noAppear = (repo.db.prepare(
    `SELECT COUNT(*) AS n FROM entities e LEFT JOIN entity_appearances a ON a.entity_id=e.id WHERE a.entity_id IS NULL`
  ).get() as { n: number }).n;
  if (noAppear > 0) warnings.push(`${noAppear} 个实体没有任何出场记录（可能抽取异常）`);

  // 其他预警
  const c = repo.counts();
  if (c.pendingDuplicates > 0) warnings.push(`${c.pendingDuplicates} 条疑似重复待人工确认（story review）`);
  if (c.openConflicts > 0) warnings.push(`${c.openConflicts} 条开放冲突记录`);
  if (c.lowConfidenceFacts > 0) warnings.push(`${c.lowConfidenceFacts} 条低置信度事实（<0.65）`);
  if (c.lowConfidenceRelations > 0) warnings.push(`${c.lowConfidenceRelations} 条低置信度关系（<0.65）`);

  // 能力无名称
  const noNameAbility = (repo.db.prepare("SELECT COUNT(*) AS n FROM abilities WHERE name IS NULL OR name=''").get() as { n: number }).n;
  if (noNameAbility > 0) errors.push(`${noNameAbility} 条能力缺少名称`);

  return { errors, warnings, chapters, availableThrough, builtThrough };
}

export async function cmdStats(): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath());
  try {
    const c = repo.counts();
    const llm = repo.llmLogSummary();
    const availableThrough = repo.availableThrough() ?? 0;
    const builtThrough = repo.builtThrough();
    const byPhase = repo.db
      .prepare("SELECT phase, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, SUM(retries) AS retries, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures FROM llm_logs GROUP BY phase")
      .all() as { phase: string; calls: number; input: number; output: number; retries: number; failures: number }[];

    section("Stats");
    log(`Book            : ${cfg.book}`);
    log(`Chapters in DB  : ${repo.countChapters()}（availableThrough = ${availableThrough}）`);
    log(`Built through   : ${builtThrough ?? 0}`);
    log(`User chapter    : ${cfg.userChapter}`);
    log("");
    log(`Characters      : ${c.characters}`);
    log(`Entities        : ${c.entities}`);
    log(`Aliases         : ${c.aliases}`);
    log(`Facts           : ${c.facts}`);
    log(`Relations       : ${c.relations}`);
    log(`Abilities       : ${c.abilities}`);
    log(`Events          : ${c.events}`);
    log(`Memory Anchors  : ${c.memoryAnchors}`);
    log(`Appearances     : ${c.appearances}`);
    log("");
    log(`LLM calls       : ${llm.calls}`);
    log(`Input tokens    : ${llm.input.toLocaleString()}`);
    log(`Output tokens   : ${llm.output.toLocaleString()}`);
    log(`Extraction retries: ${llm.retries}`);
    log(`Failed calls    : ${llm.failures}`);
    log(`Total duration  : ${(llm.duration / 1000).toFixed(1)}s`);
    if (byPhase.length) {
      log("");
      log(`按阶段：`);
      for (const p of byPhase) {
        log(`  ${padFlat(p.phase, 10)} calls=${padFlat(p.calls, 5)} input=${padFlat(p.input.toLocaleString(), 12)} output=${padFlat(p.output.toLocaleString(), 12)} retries=${p.retries} failures=${p.failures}`);
      }
    }
    if (llm.calls > 0) {
      const avgIn = Math.round(llm.input / llm.calls);
      const avgOut = Math.round(llm.output / llm.calls);
      log(`平均每次调用  : in=${avgIn} out=${avgOut}`);
      log(`估算全本成本（按当前 token 使用率 × ${1900} 章）:`);
      log(`  已构建 ${availableThrough} 章消耗  : ${llm.input.toLocaleString()} in / ${llm.output.toLocaleString()} out`);
      const ratio = 1900 / Math.max(1, availableThrough);
      log(`  1900 章预计 : ${Math.round(llm.input * ratio).toLocaleString()} in / ${Math.round(llm.output * ratio).toLocaleString()} out`);
    }

    // ── 抽取性能（千字速度 / 千字 token / 缓存命中率 / 费用） ──
    const bm = repo.buildMetrics("extract");
    if (bm.calls > 0 && bm.chars > 0) {
      const charsPerSec = bm.durationMs > 0 ? (bm.chars / bm.durationMs) * 1000 : 0;
      const cacheHit = bm.inputTokens > 0 ? (bm.inputTokens - bm.inputUncachedTokens) / bm.inputTokens : 0;
      const kChars = bm.chars / 1000;
      const price = resolveLlmPrices(cfg);
      const cost = costEstimate(bm.inputTokens, bm.inputUncachedTokens, bm.outputTokens, price);
      section("抽取性能");
      log(`处理字符 ${bm.chars.toLocaleString()}（${bm.chapters} 章）  速度 ${formatSpeed(charsPerSec)}`);
      log(`输入 ${kChars > 0 ? Math.round(bm.inputTokens / kChars).toLocaleString() : 0} tok/千字（缓存命中率 ${(cacheHit * 100).toFixed(1)}%）  输出 ${kChars > 0 ? Math.round(bm.outputTokens / kChars).toLocaleString() : 0} tok/千字`);
      log(`预估费用 ¥${cost.toFixed(2)}（输入 ¥${(price.input / 1000000 * bm.inputUncachedTokens).toFixed(2)} + 缓存 ¥${(price.cached / 1000000 * (bm.inputTokens - bm.inputUncachedTokens)).toFixed(2)} + 输出 ¥${(price.output / 1000000 * bm.outputTokens).toFixed(2)}）`);
      if (availableThrough > bm.chapters && charsPerSec > 0) {
        const avgCharsPerChapter = bm.chars / bm.chapters;
        const remaining = availableThrough - bm.chapters;
        const etaSeconds = (remaining * avgCharsPerChapter) / charsPerSec;
        log(`剩余 ${remaining} 章，按当前速度预计还需 ${formatDuration(etaSeconds)}`);
      }
    }

    // ── 完整性校验（原 story validate） ──
    const integrity = checkIntegrity(repo);
    section("完整性");
    log(`availableThrough = ${integrity.availableThrough ?? 0}   builtThrough = ${integrity.builtThrough ?? 0}   userChapter = ${cfg.userChapter}`);
    if (integrity.errors.length) {
      for (const e of integrity.errors) log(`  [ERROR] ${e}`);
    }
    if (integrity.warnings.length) {
      for (const w of integrity.warnings) warn(`  ${w}`);
    }
    if (!integrity.errors.length) log("未发现严重错误 ✔");
    if (integrity.errors.length) log(`共 ${integrity.errors.length} 个错误，${integrity.warnings.length} 个警告`);

    return integrity.errors.length > 0 ? 1 : 0;
  } finally {
    repo.close();
  }
}

/** 处理速度格式化：字符/秒 → "5.2 千字/分钟" 或 "1.3 万字/分钟" */
function formatSpeed(charsPerSec: number): string {
  if (!charsPerSec || charsPerSec <= 0) return "—";
  const perMin = charsPerSec * 60;
  return perMin >= 10000 ? `${(perMin / 10000).toFixed(1)} 万字/分钟` : `${(perMin / 1000).toFixed(1)} 千字/分钟`;
}

/** 时长格式化：秒 → "2.3 小时" / "45 分钟" / "30 秒" */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds)} 秒`;
}
