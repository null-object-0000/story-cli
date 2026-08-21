// LLM Provider 抽象：Build（抽取）与 Ask（问答）共用

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  content: string;
  /** 输入 token（不含缓存命中的部分，即纯新增） */
  inputTokens: number;
  /** 缓存命中/写入的输入 token */
  cachedTokens?: number;
  /** 输出 token */
  outputTokens: number;
  model: string;
}

/** extract 的返回值：结构化输出 + 真实 usage（可观测性：千字 token、缓存命中率、费用） */
export interface ExtractionResult {
  output: unknown;
  usage: {
    /** 总输入（含缓存，即 input + cacheRead + cacheWrite） */
    inputTokens: number;
    /** 缓存部分（命中 + 写入） */
    cachedTokens: number;
    /** 输出 */
    outputTokens: number;
  };
}

export interface CompletionOptions {
  temperature?: number;
  jsonMode?: boolean;
  /** 是否流式（默认 true） */
  stream?: boolean;
  /** 流式回调：每收到一段 content 调用一次 */
  onToken?: (text: string) => void;
  /** 推理强度："off" 关闭思考（结构化抽取默认关闭，省时间省钱）；默认按模型自身行为 */
  reasoning?: "off" | "low" | "medium" | "high";
}

export interface ChapterSlice {
  chapter: number;
  title: string;
  text: string;
}

export interface ExtractionInput {
  range: string;
  startChapter: number;
  endChapter: number;
  texts: ChapterSlice[];
  previousSummary: string | null;
  /**
   * 上一次输出的校验错误反馈（自动重试修复用）。
   * pipeline 在 validateExtractionOutput 抛 ValidationError 后，把错误信息回填到这里，
   * 让下一次尝试看到具体问题并针对性修复（而不是盲目重跑同一条 prompt）。
   * 首次调用时为空字符串/undefined。
   */
  feedback?: string;
  /**
   * 上一次尝试的完整输出 JSON（ValidationError 重试时回传）。
   * 让模型在"上一次输出"基础上【只修改被点名的记录】、其余保持逐字不变，
   * 避免每次重试都从头重新生成整份 JSON 而把其他本来正确的记录改坏（打地鼠问题）。
   * 仅校验失败（ValidationError）时回传；JSON 解析失败/截断时不下发（上次输出不可用）。
   */
  previousOutput?: string;
}

export interface LlmCapabilities {
  /** 模型上下文窗口（tokens） */
  contextWindow: number;
  /** 模型单次最大输出（tokens） */
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** 通用对话补全（默认流式，流式时通过 opts.onToken 回调增量文本） */
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
  /** 模型能力（用于自适应批次大小）；不支持时省略 */
  getCapabilities?(): LlmCapabilities;
  /** Agent 能力：返回 pi-ai 的 model 与 stream 函数（供 pi-agent-core 的 Agent 循环使用）。不支持时省略。 */
  getAgentKit?(): { model: unknown; streamFn: unknown };
}