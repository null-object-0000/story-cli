import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface StoryConfig {
  book: string;
  maxChapter: number;      // schema/结构化上限（全量章节数）
  userChapter: number;     // 用户当前阅读进度（Ask 过滤边界，默认第 1 章）
  build?: {
    batchSize: number;
    retries: number;
  };
}

export const DEFAULT_CONFIG: StoryConfig = {
  book: "我不是戏神",
  maxChapter: 405,
  userChapter: 1,
  build: { batchSize: 5, retries: 2 },
};

/** 项目根：V0.1 使用当前工作目录下的 .story */
export function projectDir(cwd = process.cwd()): string {
  return join(cwd, ".story");
}

export function configPath(cwd = process.cwd()): string {
  return join(projectDir(cwd), "config.json");
}

export function dbPath(cwd = process.cwd()): string {
  return join(projectDir(cwd), "story.db");
}

export function buildDir(cwd = process.cwd()): string {
  const d = join(projectDir(cwd), "build");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

export function ensureProjectDir(cwd = process.cwd()): void {
  mkdirSync(projectDir(cwd), { recursive: true });
}

export function loadConfig(cwd = process.cwd()): StoryConfig {
  const p = configPath(cwd);
  if (!existsSync(p)) throw new Error(`未找到项目配置 ${p}，请先运行：story init`);
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf-8")) } as StoryConfig;
}

export function saveConfig(cfg: StoryConfig, cwd = process.cwd()): void {
  ensureProjectDir(cwd);
  writeFileSync(configPath(cwd), JSON.stringify(cfg, null, 2), "utf-8");
}

export function initProject(opts: { book?: string; maxChapter?: number; userChapter?: number } = {}, cwd = process.cwd()): StoryConfig {
  ensureProjectDir(cwd);
  const cfg: StoryConfig = {
    book: opts.book || DEFAULT_CONFIG.book,
    maxChapter: opts.maxChapter ?? DEFAULT_CONFIG.maxChapter,
    userChapter: opts.userChapter ?? DEFAULT_CONFIG.userChapter,
    build: {
      batchSize: DEFAULT_CONFIG.build?.batchSize ?? 5,
      retries: DEFAULT_CONFIG.build?.retries ?? 2,
    },
  };
  saveConfig(cfg, cwd);
  return cfg;
}