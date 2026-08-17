import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface StoryConfig {
  book: string;
  maxChapter: number;      // schema/结构化上限（全量章节数）
  userChapter: number;     // 用户当前阅读进度（Ask 过滤边界，默认第 1 章）
  llm?: {
    // 连接（优先环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    // 每百万 token 价格（元，用于费用预估；也可用 LLM_PRICE_INPUT_PER_M 等环境变量）
    priceInputPerM?: number;
    priceOutputPerM?: number;
    priceCachedPerM?: number;
    /** 推理协议（自定义端点 + 推理模型时必须正确，否则思考无法关闭、输出预算被吃光）：
     *  auto=按模型名自动识别（deepseek/qwen）| deepseek | zai | qwen | openrouter | openai */
    thinkingFormat?: "auto" | "deepseek" | "zai" | "qwen" | "openrouter" | "openai";
    /** 结构化抽取时的思考强度：off 最快最省（默认）| low | medium | high
     *  （Ask 对话不受影响，保留模型自身推理能力） */
    extractReasoning?: "off" | "low" | "medium" | "high";
  };
  build?: {
    batchSize: number;      // 固定批大小（autoBatch=false 时使用）
    retries: number;
    autoBatch?: boolean;    // 自适应合并：按模型上下文动态决定每批章节数（默认 true）
    perChapterOutputTokens?: number; // 每章结构化输出的 token 估算（用于输出预算，默认 260）
    maxBatchChapters?: number;       // 单批章节数上限（防单批过大，默认 60）
    agentExtract?: boolean;  // Agent 化抽取：模型自己用工具检索已有实体（默认 true；false 回退"注入实体清单"）
    sessionLog?: boolean;     // 会话日志：每批完整 prompt/回复/工具轨迹落盘 .story/logs/build/（默认 true）
  };
}

/** 每百万 token 价格（元） */
export interface LlmPrices {
  input: number;
  output: number;
  cached: number;
}

/** 解析费用配置：环境变量优先（LLM_PRICE_*_PER_M），其次 config.llm，缺省按 OpenAI 档（输入 ¥8 / 输出 ¥24 / 缓存 ¥1.6 每百万，可自行修改） */
export function resolveLlmPrices(cfg: StoryConfig, env = process.env): LlmPrices {
  const num = (v: string | undefined, fallback: number) => {
    if (!v) return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    input: num(env.LLM_PRICE_INPUT_PER_M, cfg.llm?.priceInputPerM ?? 8),
    output: num(env.LLM_PRICE_OUTPUT_PER_M, cfg.llm?.priceOutputPerM ?? 24),
    cached: num(env.LLM_PRICE_CACHED_PER_M, cfg.llm?.priceCachedPerM ?? 1.6),
  };
}

/** 按 token 用量估算费用（元） */
export function costEstimate(inputTokens: number, uncachedInputTokens: number, outputTokens: number, p: LlmPrices): number {
  const cachedTokens = Math.max(0, inputTokens - uncachedInputTokens);
  return (uncachedInputTokens * p.input + cachedTokens * p.cached + outputTokens * p.output) / 1000000;
}

export const DEFAULT_CONFIG: StoryConfig = {
  book: "我不是戏神",
  maxChapter: 405,
  userChapter: 1,
  build: { batchSize: 1, retries: 2, autoBatch: false, perChapterOutputTokens: 260, maxBatchChapters: 60 },
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
      batchSize: DEFAULT_CONFIG.build?.batchSize ?? 1,
      retries: DEFAULT_CONFIG.build?.retries ?? 2,
      autoBatch: DEFAULT_CONFIG.build?.autoBatch ?? false,
      perChapterOutputTokens: DEFAULT_CONFIG.build?.perChapterOutputTokens ?? 260,
      maxBatchChapters: DEFAULT_CONFIG.build?.maxBatchChapters ?? 60,
    },
  };
  saveConfig(cfg, cwd);
  return cfg;
}