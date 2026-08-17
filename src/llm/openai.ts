// OpenAI-compatible LLM Provider，基于 @earendil-works/pi-ai 实现。
// 支持 30+ 提供商：DeepSeek / Qwen / OpenAI / Anthropic / Google / 以及任何 OpenAI-compatible 端点。
// 配置：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量。
// 流式输出默认开启，兼容 reasoning_content 推理模型。

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { stream as piStream, streamSimple as piStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ChatMessage, CompletionOptions, CompletionResult, ExtractionInput, ExtractionResult, LlmProvider } from "./types.js";
import { buildExtractionPrompt } from "../build/prompts.js";
import { estimateTokens } from "../util.js";

export interface PiAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number; // 整个请求（含流式）的超时，毫秒
  contextWindow?: number; // 模型上下文窗口（tokens），默认 128000，可用 LLM_CONTEXT_WINDOW 覆盖
  maxTokens?: number;     // 模型单次最大输出（tokens），默认 8192，可用 LLM_MAX_TOKENS 覆盖
  /** 推理协议（config.llm.thinkingFormat；环境变量 LLM_THINKING_FORMAT 优先） */
  thinkingFormat?: "auto" | "deepseek" | "zai" | "qwen" | "openrouter" | "openai";
  /** 抽取时的思考强度（config.llm.extractReasoning；环境变量 LLM_EXTRACT_REASONING 优先） */
  extractReasoning?: "off" | "low" | "medium" | "high";
}

interface PiModels {
  models: ReturnType<typeof createModels>;
  model: any;
}

/** 推理模型协议判定：模型名含 deepseek/Qwen 等 → 强制对应 thinkingFormat，使 reasoning:"off" 真正生效。
 *  优先级：config.llm.thinkingFormat（经 PiAiProvider.thinkingFormat）> 环境变量 LLM_THINKING_FORMAT > 自动检测。 */
function deepseekCompat(modelName: string, thinkingFormat: string): Record<string, unknown> {
  const name = modelName.toLowerCase();
  const fmt = thinkingFormat.toLowerCase();
  const isDeepseek = fmt === "deepseek" || (fmt === "auto" && (name.includes("deepseek") || name.includes("ds-")));
  const isZai = fmt === "zai";
  const isQwen = fmt === "qwen" || (fmt === "auto" && name.includes("qwen"));
  if (fmt === "openai") return {};
  if (isDeepseek) {
    // deepseek 协议：max_tokens 字段 + reasoning_content 带回传 + thinking 参数
    return {
      thinkingFormat: "deepseek",
      maxTokensField: "max_tokens" as const,
      requiresReasoningContentOnAssistantMessages: true,
      supportsReasoningEffort: true,
    };
  }
  if (isZai) return { thinkingFormat: "zai" };
  if (isQwen) return { thinkingFormat: "qwen" };
  return {};
}

export class PiAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly modelName: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  private readonly opts: PiAiOptions;
  private pi: PiModels | null = null;

  constructor(opts: PiAiOptions) {
    this.opts = opts;
    this.modelName = opts.model;
    this.contextWindow = opts.contextWindow ?? envInt("LLM_CONTEXT_WINDOW", 128000);
    this.maxTokens = opts.maxTokens ?? envInt("LLM_MAX_TOKENS", 8192);
  }

  /** 推理协议配置：环境变量 LLM_THINKING_FORMAT 优先，其次 config.llm.thinkingFormat，默认 auto */
  private get thinkingFormat(): string {
    return process.env.LLM_THINKING_FORMAT?.trim() || this.opts.thinkingFormat || "auto";
  }

  /** 抽取思考强度：环境变量 LLM_EXTRACT_REASONING 优先，其次 config.llm.extractReasoning，默认 off */
  private get extractReasoning(): "off" | "low" | "medium" | "high" {
    const v = process.env.LLM_EXTRACT_REASONING?.trim() || this.opts.extractReasoning || "off";
    return (["off", "low", "medium", "high"] as const).includes(v as any) ? (v as any) : "off";
  }

  private ensure(): PiModels {
    if (!this.pi) {
      const provider = createProvider({
        id: "llm",
        name: "Custom OpenAI-compatible",
        baseUrl: this.opts.baseUrl,
        auth: {
          apiKey: {
            name: "LLM API key",
            login: async () => {
              throw new Error("请设置 LLM_API_KEY 环境变量");
            },
            resolve: async () => {
              if (!this.opts.apiKey) return undefined;
              return { auth: { apiKey: this.opts.apiKey }, source: "LLM_API_KEY" };
            },
          },
        },
        models: [
          {
            id: this.modelName,
            name: this.modelName,
            api: "openai-completions" as const,
            provider: "llm" as const,
            baseUrl: this.opts.baseUrl,
            reasoning: true,
            input: ["text"] as const,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: this.contextWindow,
            maxTokens: this.maxTokens,
            // 自定义端点 + 推理模型的兼容设置：
            // 自定义 baseUrl 不会被 pi-ai 自动识别为 deepseek，导致 thinkingFormat 走默认分支、
            // reasoning:"off" 无法真正发送 thinking:{type:"disabled"}（此前输出预算被思考吃光的根因）。
            // 优先级：config.llm.thinkingFormat > 环境变量 LLM_THINKING_FORMAT > 模型名自动识别。
            compat: {
              supportsDeveloperRole: false,
              ...deepseekCompat(this.modelName, this.thinkingFormat),
            },
          },
        ],
        api: { stream: piStream, streamSimple: piStreamSimple },
      });
      const models = createModels();
      models.setProvider(provider);
      const model = models.getModels()[0];
      if (!model) throw new Error("pi-ai 模型创建失败");
      this.pi = { models, model };
    }
    return this.pi;
  }

  async complete(messages: ChatMessage[], extra?: CompletionOptions): Promise<CompletionResult> {
    const { models, model } = this.ensure();
    const systemPrompt = messages.find((m) => m.role === "system")?.content ?? "";
    const userMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.content }));

    const opts: Record<string, unknown> = {
      temperature: extra?.temperature ?? 0.2,
    };
    if (extra?.reasoning) {
      opts.reasoning = extra.reasoning;
    }
    if (extra?.jsonMode) {
      opts.samplingParams = { response_format: { type: "json_object" } };
    }

    const stream = extra?.stream ?? true;
    const onToken = extra?.onToken;

    const context: any = { systemPrompt, messages: userMessages };

    const run = (): Promise<CompletionResult> => {
      if (stream) {
        return this.streamComplete(models, model, context, opts, onToken);
      }
      return models.completeSimple(model, context, opts).then((result: any) => {
        if (result.stopReason === "error") {
          throw new Error(result.errorMessage ?? "LLM 返回错误");
        }
        const text = contentBlocks(result.content);
        const usage = result.usage ?? {};
        const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        return {
          content: text,
          inputTokens: usage.input ?? estimateTokens(JSON.stringify(messages)),
          cachedTokens: cached,
          outputTokens: (usage.output ?? 0) + (usage.reasoning ?? 0) || estimateTokens(text),
          model: result.model || this.modelName,
        };
      });
    };

    const timeout = this.opts.timeoutMs ?? 300_000;
    return withTimeout(run(), timeout, `LLM 请求超时（${timeout}ms）`);
  }

  private async streamComplete(
    models: ReturnType<typeof createModels>,
    model: any,
    context: any,
    opts: Record<string, unknown>,
    onToken?: (text: string) => void
  ): Promise<CompletionResult> {
    const stream = models.streamSimple(model, context, opts);
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let modelName = this.modelName;

    for await (const raw of stream) {
      const ev: any = raw;
      switch (ev.type) {
        case "text_delta": {
          const delta: string = ev.delta;
          if (delta) {
            content += delta;
            onToken?.(delta);
          }
          break;
        }
        case "usage": {
          inputTokens = ev.input ?? 0;
          outputTokens = (ev.output ?? 0) + (ev.reasoning ?? 0);
          cachedTokens = (ev.cacheRead ?? 0) + (ev.cacheWrite ?? 0);
          if (ev.model) modelName = ev.model;
          break;
        }
        case "error": {
          throw new Error(ev.error?.errorMessage ?? ev.error?.error ?? "LLM 流式请求失败");
        }
        case "done": {
          if (ev.message?.usage) {
            const u = ev.message.usage;
            inputTokens = u.input ?? 0;
            outputTokens = (u.output ?? 0) + (u.reasoning ?? 0);
            cachedTokens = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          }
          if (ev.message?.model) modelName = ev.message.model;
          break;
        }
      }
    }

    if (!content) {
      throw new Error("LLM 流式响应未返回有效文本");
    }
    return {
      content,
      inputTokens: inputTokens || estimateTokens(content),
      cachedTokens,
      outputTokens: outputTokens || estimateTokens(content),
      model: modelName,
    };
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { system, user } = buildExtractionPrompt(input);
    // 抽取思考强度：config.llm.extractReasoning > 环境变量 LLM_EXTRACT_REASONING，默认 off
    // （对应协议由 config.llm.thinkingFormat > LLM_THINKING_FORMAT > 模型名自动识别，见 deepseekCompat）
    const reasoning = this.extractReasoning;
    const result = await this.complete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1, jsonMode: true, reasoning }
    );
    const json = extractJson(result.content);
    if (json === null) {
      throw new Error("模型输出无法解析为 JSON");
    }
    // 可观测性：真实 usage（input 不含缓存；总输入 = input + cached）
    const cached = result.cachedTokens ?? 0;
    return {
      output: json,
      usage: {
        inputTokens: result.inputTokens + cached,
        cachedTokens: cached,
        outputTokens: result.outputTokens,
      },
    };
  }

  /** 模型能力（用于 Build 自适应批次大小） */
  getCapabilities(): { contextWindow: number; maxTokens: number } {
    return { contextWindow: this.contextWindow, maxTokens: this.maxTokens };
  }

  /** Agent 能力：暴露 pi-ai 的 model 与 stream 函数，供 pi-agent-core 的 Agent 循环使用 */
  getAgentKit(): { model: unknown; streamFn: unknown } {
    const { models, model } = this.ensure();
    return {
      model,
      streamFn: (m: unknown, context: unknown, opts?: Record<string, unknown>) =>
        (models.streamSimple as (model: unknown, context: unknown, opts?: Record<string, unknown>) => AsyncIterable<unknown>)(m, context, opts),
    };
  }
}

/** 从环境变量读取正整数，非法/缺失时回退默认值 */
function envInt(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 带超时包装：完成后立即清除计时器，避免进程悬挂 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 从 pi-ai 的 content 块（thinking + text）中提取纯文本 */
function contentBlocks(blocks: { type: string; text?: string }[]): string {
  return (blocks ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** 从模型输出中提取 JSON（容忍 markdown 代码块、前后杂质） */
export function extractJson(text: string): unknown | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t);
  const candidate = fence ? fence[1] : t;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}