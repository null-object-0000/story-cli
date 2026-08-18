// Ask 会话日志：把每轮问答的 agent 事件落盘为 JSONL（.story/logs/ask/session-*.jsonl），
// 与 build 的 session-log 对齐，供排查"模型空回答/卡住/工具调用异常"等行为问题。
// 记录内容：用户问题、每条助手消息（text/thinking/toolCalls/stopReason）、工具调用与结果、最终答案、耗时。
// 注意：只记录结构化数据与对话文本，绝不落盘 chapters 原文（Reader 代码路径上本就不存在原文）。

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface AskLogEntry {
  seq: number;
  ts: string;
  kind: "meta" | "question" | "assistant" | "tool_call" | "tool_result" | "answer" | "error" | "end";
  /** 用户问题 / 助手文本 / 最终答案 */
  text?: string;
  /** 助手思考（reasoning_content / thinking 块） */
  thinking?: string;
  /** 工具名 */
  tool?: string;
  /** 工具参数 */
  args?: unknown;
  /** 工具结果摘要 / 错误 */
  detail?: string;
  error?: string;
  /** 模型 stopReason / 消息 role */
  stopReason?: string;
  role?: string;
  /** 上下文信息（userChapter / model / mode） */
  meta?: Record<string, unknown>;
  tokens?: { input: number; output: number };
  toolCalls?: number;
  toolFailures?: number;
  durationMs?: number;
}

const MAX_TEXT = 2000; // 单条文本截断，避免文件膨胀

function truncateText(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `…（截断，共 ${s.length} 字）` : s;
}

export class AskSessionLogger {
  readonly path: string;
  private seq = 0;

  constructor(cwd = process.cwd()) {
    const dir = join(cwd, ".story", "logs", "ask");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(dir, `session-${stamp}.jsonl`);
    this.log({ kind: "meta", text: "ask session started" });
  }

  log(entry: Omit<AskLogEntry, "seq" | "ts">): void {
    const line: AskLogEntry = {
      ...entry,
      seq: ++this.seq,
      ts: new Date().toISOString(),
    };
    if (typeof line.text === "string") line.text = truncateText(line.text);
    if (typeof line.thinking === "string") line.thinking = truncateText(line.thinking);
    if (typeof line.detail === "string") line.detail = truncateText(line.detail);
    appendFileSync(this.path, JSON.stringify(line) + "\n", "utf-8");
  }
}

/** 把 pi-agent-core 事件映射成日志条目（app.ts 与 askAgent 的 subscribe 都调用） */
export function logAskEvent(logger: AskSessionLogger, event: unknown): void {
  const e = event as any;
  if (e.type === "message_end" && e.message?.role === "assistant") {
    const msg = e.message;
    const content: any[] = msg.content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
    const thinking = content.filter((c) => c.type === "thinking").map((c) => c.thinking ?? "").join("");
    const toolCalls = content.filter((c) => c.type === "toolCall");
    logger.log({
      kind: "assistant",
      role: msg.role,
      stopReason: msg.stopReason,
      text: text || undefined,
      thinking: thinking || undefined,
      detail: toolCalls.length > 0
        ? `含 ${toolCalls.length} 个工具调用：${toolCalls.map((t) => t.name).join(", ")}`
        : undefined,
    });
  } else if (e.type === "tool_execution_start") {
    logger.log({ kind: "tool_call", tool: e.toolName, args: e.args });
  } else if (e.type === "tool_execution_end") {
    const isError = e.isError;
    // 注意：tool_execution_end 事件没有 error 字段——错误信息在 result.content[0].text 里
    // （pi-agent-core 的 createErrorToolResult 把 message 放进文本块）
    const firstText = ((e.result?.content?.[0] as any)?.text ?? "").slice(0, 300);
    logger.log({
      kind: "tool_result",
      tool: e.toolName,
      error: isError ? (firstText || "执行失败") : undefined,
      detail: isError ? undefined : (firstText || "(空结果)"),
    });
  }
}
