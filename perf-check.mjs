import sqlite3 from "sqlite3";
const db = new sqlite3.Database(".story/story.db", sqlite3.OPEN_READONLY);
const q = (sql, params=[]) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
(async () => {
  console.log("=== llm_logs 列 ===");
  const cols = await q("PRAGMA table_info(llm_logs)");
  console.log(cols.map(c => c.name).join(", "));
  console.log("=== 最近 15 条 extract 日志 ===");
  const rows = await q(`SELECT id, range, success, retries, chars, chapters, input_tokens, input_uncached_tokens, output_tokens, duration_ms FROM llm_logs WHERE phase='extract' ORDER BY id DESC LIMIT 15`);
  for (const r of rows) {
    const speed = r.duration_ms > 0 ? ((r.chars / r.duration_ms) * 60000).toFixed(1) : "-";
    const cached = r.input_tokens - r.input_uncached_tokens;
    console.log(`[${String(r.id).padStart(3)}] ${String(r.range).padStart(9)} ${r.success ? "OK" : "FAIL"} retries=${r.retries} chars=${r.chars} chap=${r.chapters} in=${r.input_tokens} cached=${cached} out=${r.output_tokens} dur=${(r.duration_ms / 1000).toFixed(1)}s (${speed}千字/分)`);
  }
  console.log("\n=== 最近窗口指标（最近100条成功） ===");
  const m = (await q(`WITH recent AS (SELECT chars, chapters, input_tokens, input_uncached_tokens, output_tokens, duration_ms FROM llm_logs WHERE phase='extract' AND success=1 AND chars>0 ORDER BY id DESC LIMIT 100) SELECT COUNT(*) AS calls, COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(chapters),0) AS chapters, COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(input_uncached_tokens),0) AS iu, COALESCE(SUM(output_tokens),0) AS ot, COALESCE(SUM(duration_ms),0) AS ms FROM recent`))[0];
  const v = (m.chars / m.ms) * 60000;
  const cachedRate = m.it > 0 ? (((m.it - m.iu) / m.it) * 100).toFixed(1) : "-";
  console.log(`calls=${m.calls} 速度 ${v.toFixed(1)} 千字/分 | 输出/千字 ${(m.ot / (m.chars / 1000)).toFixed(0)} | 输入缓存命中率 ${cachedRate}%`);
  console.log("\n=== batch_state 最近 10 个 ===");
  const bs = await q("SELECT range, status, finished_at FROM batch_state ORDER BY id DESC LIMIT 10");
  for (const b of bs) console.log(`  ${String(b.range).padEnd(9)} ${String(b.status).padEnd(6)} ${b.finished_at ?? ""}`);
  console.log("\n=== 完成度 ===");
  console.log(" chapters(已导入原文):", (await q("SELECT COUNT(*) AS n FROM chapters"))[0].n);
  console.log(" done batches:", (await q("SELECT COUNT(*) AS n FROM batch_state WHERE status='done'"))[0].n);
  console.log(" failed batches:", (await q("SELECT COUNT(*) AS n FROM batch_state WHERE status='failed'"))[0].n);
  db.close();
})();
