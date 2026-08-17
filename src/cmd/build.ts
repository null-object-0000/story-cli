// story build：分批量 LLM 抽取 + 断点续跑 + 重试 + 成本统计

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { runBuild } from "../build/pipeline.js";
import { createProvider } from "../llm/index.js";
import { log, warn, section } from "../logger.js";

export async function cmdBuild(
  flags: Record<string, string | boolean>,
  positional: string[]
): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  try {
    const providerFlag = flags["--provider"];
    if (providerFlag && providerFlag !== "openai" && providerFlag !== "mock") {
      throw new Error(`--provider 可选值为 openai|mock，收到：${providerFlag}`);
    }
    const { provider, mode } = createProvider(cfg, providerFlag as any | undefined);
    if (mode === "mock") {
      warn("未检测到 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL，使用内置 mock 抽取器（仅用于验证管道，不代表真实抽取质量）");
    } else {
      log(`LLM: ${provider.name}（model=${(provider as any).modelName ?? "?"}）`);
    }

    const fromChapter = parseNum(flags["--from-chapter"]);
    const toChapter = parseNum(flags["--to-chapter"]);
    const batchSize = parseNum(flags["--batch-size"]) ?? cfg.build?.batchSize ?? 5;
    const retries = parseNum(flags["--retries"]) ?? cfg.build?.retries ?? 2;
    const force = flags["--force"] === true || flags["--force"] === "true";
    const concurrency = parseNum(flags["--parallel"]) ?? 1;

    const started = Date.now();
    const res = await runBuild(repo, provider, {
      fromChapter,
      toChapter,
      force,
      batchSize,
      retries,
      concurrency,
      maxChapter: cfg.maxChapter,
    });

    section("Build 结果");
    for (const b of res.processed) {
      log(`[${b.range}] ${b.status === "done" ? "done" : "FAILED"}  entities:+${b.newEntities} u:${b.entityUpdates} aliases:${b.aliases} facts:${b.facts} relations:${b.relations} abilities:${b.abilities} events:${b.events} anchors:${b.memoryAnchors} dup:${b.duplicates}`);
    }
    if (res.failed > 0) warn(`${res.failed} 个批次失败（可用 story build --force 重跑失败区间）`);

    const c = repo.counts();
    const chapters = repo.countChapters();
    const dur = ((Date.now() - started) / 1000).toFixed(1);
    log("");
    log(`Build complete（耗时 ${dur}s）`);
    log(`Chapters      : ${chapters}`);
    log(`Characters    : ${c.characters}`);
    log(`Entities      : ${c.entities}`);
    log(`Aliases       : ${c.aliases}`);
    log(`Facts         : ${c.facts}`);
    log(`Relations     : ${c.relations}`);
    log(`Abilities     : ${c.abilities}`);
    log(`Events        : ${c.events}`);
    log(`Memory Anchors: ${c.memoryAnchors}`);
    log(`Appearances   : ${c.appearances}`);
    log("");
    log(`Possible duplicates: ${c.pendingDuplicates}（story review 可人工确认）`);
    log(`Open conflicts     : ${c.openConflicts}`);
    log(`Low-confidence facts: ${c.lowConfidenceFacts}`);
    return res.failed > 0 ? 2 : 0;
  } finally {
    repo.close();
  }
}

function parseNum(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}