// OpenAI-compatible LLM Provider，基于 @earendil-works/pi-ai 实现。
// 支持 30+ 提供商：DeepSeek / Qwen / OpenAI / Anthropic / Google / 以及任何 OpenAI-compatible 端点。
// 配置：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 环境变量。
// 流式输出默认开启，兼容 reasoning_content 推理模型。

import { createModels, createProvider } from "@earendil-works/pi-ai";
import { stream as piStream, streamSimple as piStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ChatMessage, CompletionOptions, CompletionResult, ExtractionInput, LlmProvider } from "./types.js";
import { buildExtractionPrompt } from "../build/prompts.js";
import { estimateTokens } from "../util.js";

export interface PiAiOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number; // 整个请求（含流式）的超时，毫秒
}

interface PiModels {
  models: ReturnType<typeof createModels>;
  model: any;
}

export class PiAiProvider implements LlmProvider {
  readonly name = "openai";
  readonly modelName: string;
  private readonly opts: PiAiOptions;
  private pi: PiModels | null = null;

  constructor(opts: PiAiOptions) {
    this.opts = opts;
    this.modelName = opts.model;
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
            contextWindow: 128000,
            maxTokens: 8192,
            compat: { supportsDeveloperRole: false },
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
        return {
          content: text,
          inputTokens: usage.input ?? estimateTokens(JSON.stringify(messages)),
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
      outputTokens: outputTokens || estimateTokens(content),
      model: modelName,
    };
  }

  async extract(input: ExtractionInput): Promise<unknown> {
    const { system, user } = buildExtractionPrompt(input);
    const result = await this.complete(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.1, jsonMode: true }
    );
    const json = extractJson(result.content);
    if (json === null) {
      throw new Error("模型输出无法解析为 JSON");
    }
    return json;
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