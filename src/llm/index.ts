// Provider 选择：环境变量（含 .env 文件）优先，其次 story init 时写入 config 的 llm 字段，最后回退 mock。
// 当 LLM 环境变量齐全时，使用 @earendil-works/pi-ai 作为底座（支持 30+ 提供商）。
// 否则使用内置 mock 抽取器 + 模板回答器（离线验证管道）。

import { LlmProvider } from "./types.js";
import { PiAiProvider } from "./openai.js";
import { MockProvider } from "./mock.js";
import { StoryConfig } from "../config.js";
import { loadEnvFile } from "../env.js";

export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveLlmSettings(cfg: StoryConfig, env = process.env): LlmSettings | null {
  // 支持从项目根 .env 读取（真实环境变量优先，.env 不覆盖）
  loadEnvFile();
  const baseUrl = env.LLM_BASE_URL?.trim() || (cfg as any).llm?.baseUrl || "";
  const apiKey = env.LLM_API_KEY?.trim() || (cfg as any).llm?.apiKey || "";
  const model = env.LLM_MODEL?.trim() || (cfg as any).llm?.model || "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

export function createProvider(cfg: StoryConfig, override?: "openai" | "mock"): { provider: LlmProvider; mode: "llm" | "mock" } {
  if (override === "mock") return { provider: new MockProvider(), mode: "mock" };
  const settings = resolveLlmSettings(cfg);
  if (override === "openai" && !settings) {
    throw new Error("选择了 openai provider 但缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量");
  }
  if (settings) {
    return {
      provider: new PiAiProvider({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model }),
      mode: "llm",
    };
  }
  return { provider: new MockProvider(), mode: "mock" };
}