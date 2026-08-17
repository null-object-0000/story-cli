// story import：解析小说 → 物理截断到 maxChapter → 保存章节（含正文，供 Build 使用）
// 硬约束：第 maxChapter+1 章及以后直接丢弃，绝不入库。

import { readFileSync, existsSync } from "node:fs";
import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { parseNovel, decodeNovel } from "../novel/parser.js";
import { log, warn, section } from "../logger.js";

export interface ImportOptions {
  path: string;
  toChapter?: number;
  book?: string;
}

export async function cmdImport(opts: ImportOptions): Promise<number> {
  if (!existsSync(opts.path)) {
    throw new Error(`文件不存在：${opts.path}`);
  }
  const buf = readFileSync(opts.path);
  const text = decodeNovel(buf);

  // 读取/校准配置
  let cfg = loadConfig();
  if (opts.toChapter && opts.toChapter !== cfg.maxChapter) {
    warn(`--to-chapter ${opts.toChapter} 与配置 maxChapter=${cfg.maxChapter} 不同，将更新配置并重建数据库（旧数据清空）`);
    cfg = { ...cfg, maxChapter: opts.toChapter };
    const { saveConfig, ensureProjectDir } = await import("../config.js");
    ensureProjectDir();
    saveConfig(cfg);
    // schema 已绑定旧上限，需要重建库
    const { rmSync } = await import("node:fs");
    rmSync(dbPath(), { force: true });
    for (const s of ["-wal", "-shm"]) rmSync(dbPath() + s, { force: true });
  }

  const maxChapter = cfg.maxChapter;
  const result = parseNovel(text, maxChapter);

  const repo = new StoryRepo(dbPath(), maxChapter);
  try {
    // 全新导入：清空全部旧数据（保证不会残留上一本书/上一次导入的脏数据）
    resetAllData(repo);
    repo.setMeta("book", cfg.book);
    repo.setMeta("max_chapter", String(maxChapter));
    repo.setMeta("source_file", opts.path);

    repo.replaceChapters(result.chapters.map((c) => ({ number: c.number, title: c.title, text: c.text })));
  } finally {
    repo.close();
  }

  section("导入结果");
  log(`文件      : ${opts.path}`);
  log(`书目      : ${cfg.book}`);
  log(`识别章节  : ${result.chapters.length} 章（第 1 ~ ${result.chapters.length ? result.chapters[result.chapters.length - 1].number : 0} 章）`);
  if (result.duplicates) warn(`发现 ${result.duplicates} 个重复章节号，已按先出现者保留`);
  if (result.droppedFrom !== null && result.droppedCount > 0) {
    warn(`物理截断：丢弃第 ${result.droppedFrom} 章及以后的 ${result.droppedCount} 个章节（防剧透硬边界 maxChapter=${maxChapter}）`);
  }
  if (result.chapters.length === 0) {
    warn("未识别到任何“第N章”标题，请检查文件格式（需要类似“第1章 章节名”的行）");
  } else if (result.chapters[result.chapters.length - 1].number < maxChapter) {
    warn(`文件实际只有 ${result.chapters[result.chapters.length - 1].number} 章，不足配置的 ${maxChapter} 章`);
  }
  log("下一步    : story build （分批次抽取结构化数据）");
  return 0;
}

/** 清空全部业务数据（章节 + 结构化 + 日志），保留 meta */
export function resetAllData(repo: StoryRepo): void {
  const tables = [
    "chapters", "entities", "aliases", "facts", "relations", "abilities", "events",
    "memory_anchors", "entity_appearances", "possible_duplicates", "conflicts",
    "llm_logs", "batch_state", "review_log",
  ];
  repo.db.exec("BEGIN");
  try {
    for (const t of tables) repo.db.exec(`DELETE FROM ${t}`);
    repo.db.exec("COMMIT");
  } catch (e) {
    repo.db.exec("ROLLBACK");
    throw e;
  }
}