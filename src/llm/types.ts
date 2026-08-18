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

export interface KnownEntityDigest {
  id: string;
  name: string;
  type: string;
}

export interface ExtractionInput {
  range: string;
  startChapter: number;
  endChapter: number;
  texts: ChapterSlice[];
  knownEntities: KnownEntityDigest[];
  aliases: { alias: string; entityId: string; entityName: string }[];
  previousSummary: string | null;
}

export interface LlmCapabilities {
  /** 模型上下文窗口（tokens） */
  contextWindow: number;
  /** 模型单次最大输出（tokens） */
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  /** 抽取：返回结构化输出 + 真实 usage（未校验的原始 JSON 对象）；失败抛错 */
  extract(input: ExtractionInput): Promise<ExtractionResult>;
  /** 通用对话补全（默认流式，流式时通过 opts.onToken 回调增量文本） */
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
  /** 模型能力（用于自适应批次大小）；不支持时省略 */
  getCapabilities?(): LlmCapabilities;
  /** Agent 能力：返回 pi-ai 的 model 与 stream 函数（供 pi-agent-core 的 Agent 循环使用）。不支持时省略。 */
  getAgentKit?(): { model: unknown; streamFn: unknown };
}