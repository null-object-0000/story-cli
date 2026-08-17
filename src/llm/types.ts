// LLM Provider 抽象：Build（抽取）与 Ask（问答）共用

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CompletionOptions {
  temperature?: number;
  jsonMode?: boolean;
  /** 是否流式（默认 true） */
  stream?: boolean;
  /** 流式回调：每收到一段 content 调用一次 */
  onToken?: (text: string) => void;
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
  maxChapter: number;
}

export interface LlmProvider {
  readonly name: string;
  /** 抽取：返回 LLM 输出（未校验的原始 JSON 对象）；失败抛错 */
  extract(input: ExtractionInput): Promise<unknown>;
  /** 通用对话补全（默认流式，流式时通过 opts.onToken 回调增量文本） */
  complete(messages: ChatMessage[], opts?: CompletionOptions): Promise<CompletionResult>;
  /** Agent 能力：返回 pi-ai 的 model 与 stream 函数（供 pi-agent-core 的 Agent 循环使用）。不支持时省略。 */
  getAgentKit?(): { model: unknown; streamFn: unknown };
}