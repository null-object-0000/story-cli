// story init：创建项目配置与数据库
// 核心逻辑抽成 initializeProject / logInitSummary，供 story tui 未初始化时复用
//
// V0.1 收口：config 不再保存 maxChapter（全量章节数由 chapters 数据自动决定）。
// 章节最大值变化不再触发重建 DB——schema 不再把最大章节号编译进去。

import { existsSync } from "node:fs";
import { initProject, loadConfig, projectDir, dbPath, ensureProjectDir, type StoryConfig } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { log } from "../logger.js";

export async function cmdInit(args: { positional: string[]; flags: Record<string, string | boolean> }): Promise<number> {
  const book = typeof args.flags["--book"] === "string" ? args.flags["--book"] : undefined;
  const userChapter = parseUserChapterFlag(args.flags);
  const to = args.positional[0];

  const cfg = initializeProject({ book, userChapter });
  logInitSummary(cfg, to);
  return 0;
}

/** 创建（或重载）项目配置与数据库，返回生成的配置。与 story init 行为一致。 */
export function initializeProject(
  opts: { book?: string; userChapter?: number } = {},
  cwd = process.cwd()
): StoryConfig {
  ensureProjectDir(cwd);
  const cfg = initProject(opts, cwd);
  const repo = new StoryRepo(dbPath(cwd));
  repo.setMeta("book", cfg.book);
  repo.close();
  return cfg;
}

/** 打印 story init 的完成摘要（story tui 未初始化自动初始化后也复用） */
export function logInitSummary(cfg: StoryConfig, to?: string): void {
  log(`初始化完成：${projectDir()}`);
  log(`  book        = ${cfg.book}`);
  log(`  userChapter = ${cfg.userChapter}（Reader 阅读进度，检索只返回 ≤ 该章的数据；默认第 1 章，保守）`);
  log(`              可用 /chapter <N>（TUI）或 story ask --chapter <N> 调整`);
  log(`  availableThrough 由 story import 导入的章节数自动决定，无需配置。`);
  if (to) log(`提示：可以运行 story import ${to} 导入小说。`);
}

export function parseUserChapterFlag(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--user-chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--user-chapter 必须是正整数：${v}`);
  return n;
}
