// story audit-spoilers：防剧透审计（任何 chapter > maxChapter 的记录 → exit code != 0）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { log, section } from "../logger.js";

interface Violation {
  table: string;
  column: string;
  chapter: number;
  detail: string;
}

export async function cmdAuditSpoilers(): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  const maxChapter = cfg.maxChapter;
  const violations: Violation[] = [];
  try {
    // 对每个带章节号的表：checked = 总记录数，violations = 越界数
    const collect = (table: string, col: string, detailCol: string | null): { checked: number; found: number } => {
      const total = (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const rows = repo.db
        .prepare(`SELECT * FROM ${table} WHERE ${col} IS NOT NULL AND ${col} > ?`)
        .all(maxChapter) as Record<string, unknown>[];
      for (const r of rows) {
        violations.push({
          table,
          column: col,
          chapter: r[col] as number,
          detail: detailCol ? String(r[detailCol] ?? "") : "",
        });
      }
      return { checked: total, found: rows.length };
    };

    const counts: { label: string; checked: number; violations: number }[] = [];
    const e = collect("entities", "first_seen_chapter", "name");
    const e2 = collect("entities", "last_seen_chapter", "name");
    counts.push({ label: "Entities", checked: e.checked, violations: e.found + e2.found });
    for (const [label, table, col, detail] of [
      ["Aliases", "aliases", "from_chapter", "alias"],
      ["Facts", "facts", "chapter", "value"],
      ["Relations", "relations", "chapter", "type"],
      ["Abilities", "abilities", "chapter", "name"],
      ["Events", "events", "chapter", "summary"],
      ["Memory anchors", "memory_anchors", "chapter", "summary"],
      ["Appearances", "entity_appearances", "chapter", "entity_id"],
    ] as [string, string, string, string][]) {
      const r = collect(table, col, detail);
      counts.push({ label, checked: r.checked, violations: r.found });
    }
    const abilities2 = collect("abilities", "acquired_chapter", "name");
    counts.find((c) => c.label === "Abilities")!.violations += abilities2.found;

    section("防剧透审计（Spoiler Audit）");
    log(`Max allowed chapter: ${maxChapter}`);
    log("");
    for (const c of counts) {
      log(`${c.label.padEnd(18)} checked: ${c.checked}    violations: ${c.violations}`);
    }
    log(`Chapters${"".padEnd(11)} checked: ${repo.countChapters()}    violations: ${repo.countChapters() > maxChapter ? repo.countChapters() - maxChapter : 0}`);
    log("");
    if (violations.length === 0) {
      log("Spoiler violations: 0");
      log("无任何越界章节记录 ✔ Ask 阶段只能检索到 maxChapter 以内的结构化数据。");
      return 0;
    }
    log(`Spoiler violations: ${violations.length}`);
    for (const v of violations.slice(0, 50)) {
      log(`  [${v.table}.${v.column}] chapter=${v.chapter} ${v.detail.slice(0, 60)}`);
    }
    if (violations.length > 50) log(`  ... 还有 ${violations.length - 50} 条`);
    return 1;
  } finally {
    repo.close();
  }
}