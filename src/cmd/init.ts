// story init：创建项目配置与数据库

import { existsSync, rmSync } from "node:fs";
import { initProject, loadConfig, projectDir, dbPath, ensureProjectDir } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { log, warn } from "../logger.js";

export async function cmdInit(args: { positional: string[]; flags: Record<string, string | boolean> }): Promise<number> {
  const book = typeof args.flags["--book"] === "string" ? args.flags["--book"] : undefined;
  const maxChapter = parseMaxChapterFlag(args.flags);
  const userChapter = parseUserChapterFlag(args.flags);
  const to = args.positional[0];

  ensureProjectDir();
  let prevMax: number | null = null;
  if (existsSync(dbPath())) {
    try {
      prevMax = loadConfig().maxChapter;
    } catch {
      prevMax = null;
    }
  }

  const cfg = initProject({ book, maxChapter, userChapter }, process.cwd());
  // schema 上限若与既有库不一致，重建（数据会清空）
  if (existsSync(dbPath())) {
    if (prevMax !== null && prevMax !== cfg.maxChapter) {
      warn(`maxChapter 从 ${prevMax} 变为 ${cfg.maxChapter}，重建 story.db（旧数据将被清空）`);
      rmSync(dbPath(), { force: true });
      for (const suffix of ["-wal", "-shm"]) rmSync(dbPath() + suffix, { force: true });
    }
  }
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  repo.setMeta("book", cfg.book);
  repo.setMeta("max_chapter", String(cfg.maxChapter));
  repo.close();

  log(`初始化完成：${projectDir()}`);
  log(`  book        = ${cfg.book}`);
  log(`  maxChapter  = ${cfg.maxChapter}（结构化上限，全量章节）`);
  log(`  userChapter = ${cfg.userChapter}（Ask 阅读进度，检索只返回 ≤ 该章的数据）`);
  log(`              可用 /chapter <N>（TUI）或 story ask --chapter <N> 调整`);
  if (to) log(`提示：可以运行 story import ${to} 导入小说。`);
  return 0;
}

export function parseMaxChapterFlag(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--max-chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--max-chapter 必须是正整数：${v}`);
  return n;
}

export function parseUserChapterFlag(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--user-chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--user-chapter 必须是正整数：${v}`);
  return n;
}