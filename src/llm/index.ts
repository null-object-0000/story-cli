// Provider 选择：环境变量（含 .env 文件）优先，其次 config 的 llm 字段。不再有 mock。
// 未配置任何 LLM 连接时直接抛错（Ask/Build/TUI 都需要真实 LLM）。

import { LlmProvider } from "./types.js";
import { PiAiProvider } from "./openai.js";
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
  const baseUrl = env.LLM_BASE_URL?.trim() || cfg.llm?.baseUrl || "";
  const apiKey = env.LLM_API_KEY?.trim() || cfg.llm?.apiKey || "";
  const model = env.LLM_MODEL?.trim() || cfg.llm?.model || "";
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl, apiKey, model };
}

/** 创建 LLM provider（OpenAI-compatible，pi-ai 底座）。未配置连接时抛错。 */
export function createProvider(cfg: StoryConfig): LlmProvider {
  const settings = resolveLlmSettings(cfg);
  if (!settings) {
    throw new Error(
      "未配置 LLM 连接（需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL：环境变量、.env，或运行 story tui 后在 TUI 内 /login 写入 .story/config.json 的 llm.*）"
    );
  }
  return new PiAiProvider({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    // 用户自配置（config.llm 字段；环境变量仍可覆盖，见 PiAiProvider）
    thinkingFormat: cfg.llm?.thinkingFormat,
    extractReasoning: cfg.llm?.extractReasoning,
    contextWindow: cfg.llm?.contextWindow,
    maxTokens: cfg.llm?.maxTokens,
  });
}
