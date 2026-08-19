// story init <小说文件>：创建项目配置与数据库 + 导入整本小说（初始化就必须有小说内容）。
// 合并了原 story import：init 即建项目即导入；重新初始化/更换小说 = 用新文件再跑一次 story init。
//
// V0.1 收口：config 不再保存 maxChapter（全量章节数由 chapters 数据自动决定）。

import { loadConfig, projectDir, dbPath, ensureProjectDir, initProject, type StoryConfig } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { log } from "../../logger.js";

export async function cmdInit(args: { positional: string[]; flags: Record<string, string | boolean> }): Promise<number> {
  const path = args.positional[0];
  if (!path) {
    throw new Error("用法：story init <小说文件路径> [--book 书名] [--user-chapter N]");
  }
  const book = typeof args.flags["--book"] === "string" ? args.flags["--book"] : undefined;
  const userChapter = parseUserChapterFlag(args.flags);

  // 1) 创建（或复用）项目配置与数据库
  initializeProject({ book, userChapter });

  // 2) 导入整本小说（清空旧数据 → 写章节 → 设书名；book 由 --book 或文件名决定）
  const { cmdImport } = await import("./import.js");
  const code = await cmdImport({ path, book });

  // 3) 摘要（import 已把最终 book 写回 config）
  const cfg = loadConfig();
  logInitSummary(cfg, path);
  return code;
}

/** 创建（或重载）项目配置与数据库，返回生成的配置。 */
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

/** 打印 story init 的完成摘要 */
export function logInitSummary(cfg: StoryConfig, novelPath?: string): void {
  log(`初始化完成：${projectDir()}`);
  log(`  book        = ${cfg.book}`);
  log(`  userChapter = ${cfg.userChapter}（Reader 阅读进度，检索只返回 ≤ 该章的数据；默认第 1 章，保守）`);
  log(`              可用 /chapter <N>（TUI）或 story ask --chapter <N> 调整`);
  if (novelPath) log(`  novel       = ${novelPath}`);
  log(`  availableThrough 由导入的章节数自动决定，无需配置。`);
}

export function parseUserChapterFlag(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--user-chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--user-chapter 必须是正整数：${v}`);
  return n;
}