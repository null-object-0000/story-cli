// story stats：成本与数据统计

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { log, section } from "../logger.js";
import { pad as padFlat } from "../util.js";

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
    return 0;
  } finally {
    repo.close();
  }
}