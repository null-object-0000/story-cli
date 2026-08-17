// story validate：完整性检查（错误 → exit code 1）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { log, warn, section } from "../logger.js";

export async function cmdValidate(): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  const errors: string[] = [];
  const warnings: string[] = [];
  let chapters = 0;

  try {
    // 0. 章节库
    chapters = repo.countChapters();
    if (chapters === 0) errors.push("chapters 表为空：请先 story import");
    const dbMax = repo.maxChapterInDb();
    if (dbMax !== null && dbMax > cfg.maxChapter) errors.push(`chapters 最大章节 ${dbMax} > maxChapter ${cfg.maxChapter}`);

    // 1. 章节越界（严重）—— DB CHECK 下理论上不可能，但防一手
    const overMax = (table: string, col: string) =>
      (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IS NOT NULL AND ${col} > ?`).get(cfg.maxChapter) as { n: number }).n;

    const checks: [string, string][] = [
      ["entities", "first_seen_chapter"],
      ["entities", "last_seen_chapter"],
      ["aliases", "from_chapter"],
      ["facts", "chapter"],
      ["relations", "chapter"],
      ["abilities", "chapter"],
      ["abilities", "acquired_chapter"],
      ["events", "chapter"],
      ["memory_anchors", "chapter"],
      ["entity_appearances", "chapter"],
    ];
    for (const [t, c] of checks) {
      const n = overMax(t, c);
      if (n > 0) errors.push(`${t}.${c} 有 ${n} 条记录超过 maxChapter=${cfg.maxChapter}（严重：防剧透违规）`);
    }

    // 2. 孤儿别名
    const orphanAliases = (repo.db.prepare(
      "SELECT COUNT(*) AS n FROM aliases a LEFT JOIN entities e ON e.id=a.entity_id WHERE e.id IS NULL"
    ).get() as { n: number }).n;
    if (orphanAliases > 0) errors.push(`孤儿 Alias：${orphanAliases} 条（引用不存在的实体）`);

    // 3. 引用不存在的实体
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
    // 自环
    const selfLoop = (repo.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE from_entity_id=to_entity_id").get() as { n: number }).n;
    if (selfLoop > 0) errors.push(`relations 有 ${selfLoop} 条自环记录`);

    // 4. firstSeen 异常
    const badFirst = (repo.db.prepare(
      "SELECT COUNT(*) AS n FROM entities WHERE first_seen_chapter IS NULL OR first_seen_chapter < 1"
    ).get() as { n: number }).n;
    if (badFirst > 0) errors.push(`${badFirst} 个实体缺少有效的 first_seen_chapter`);

    // 5. 重复实体名
    const dupNames = (repo.db.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT type,name FROM entities GROUP BY type,name HAVING COUNT(*)>1)"
    ).get() as { n: number }).n;
    if (dupNames > 0) errors.push(`${dupNames} 组重复名称实体（同类型同名）`);

    // 6. 重要数据缺章
    const noChapter = (repo.db.prepare(
      `SELECT COUNT(*) AS n FROM facts WHERE chapter IS NULL OR chapter<1`
    ).get() as { n: number }).n;
    if (noChapter > 0) errors.push(`${noChapter} 条事实缺少有效章节号`);

    // 7. 没有出场记录的实体
    const noAppear = (repo.db.prepare(
      `SELECT COUNT(*) AS n FROM entities e LEFT JOIN entity_appearances a ON a.entity_id=e.id WHERE a.entity_id IS NULL`
    ).get() as { n: number }).n;
    if (noAppear > 0) warnings.push(`${noAppear} 个实体没有任何出场记录（可能抽取异常）`);

    // 8. 其他预警
    const c = repo.counts();
    if (c.pendingDuplicates > 0) warnings.push(`${c.pendingDuplicates} 条疑似重复待人工确认（story review）`);
    if (c.openConflicts > 0) warnings.push(`${c.openConflicts} 条开放冲突记录`);
    if (c.lowConfidenceFacts > 0) warnings.push(`${c.lowConfidenceFacts} 条低置信度事实（<0.65）`);
    if (c.lowConfidenceRelations > 0) warnings.push(`${c.lowConfidenceRelations} 条低置信度关系（<0.65）`);

    // 9. 能力 owner 检查（已在 dangling 覆盖）+ 能力无名称
    const noNameAbility = (repo.db.prepare("SELECT COUNT(*) AS n FROM abilities WHERE name IS NULL OR name=''").get() as { n: number }).n;
    if (noNameAbility > 0) errors.push(`${noNameAbility} 条能力缺少名称`);

  } finally {
    repo.close();
  }

  section("Validate 结果");
  log(`maxChapter = ${cfg.maxChapter}`);
  log(`chapters   = ${chapters}`);
  if (errors.length) {
    for (const e of errors) log(`  [ERROR] ${e}`);
  }
  if (warnings.length) {
    for (const w of warnings) warn(w);
  }
  if (!errors.length) log("未发现严重错误 ✔");
  if (errors.length) log(`\n共 ${errors.length} 个错误，${warnings.length} 个警告`);
  return errors.length > 0 ? 1 : 0;
}