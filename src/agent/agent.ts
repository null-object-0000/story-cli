// Agent 组装与执行：基于 pi-agent-core 的 Agent 类，驱动小说领域工具。
// 提供两种模式：
//   1. askAgent()  — 非交互式问答（流式输出到 stdout，用于 story ask）
//   2. createAgent() — 创建 Agent 实例供 TUI 交互界面使用

import { Agent } from "@earendil-works/pi-agent-core";
import { StoryRepo } from "../db/repo.js";
import { StoryConfig } from "../config.js";
import { LlmProvider } from "../llm/types.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { buildNovelTools, NovelToolContext } from "./tools.js";
import { log } from "../logger.js";

/** Agent 最大工具调用轮数（防止模型无限循环调用工具） */
const MAX_TOOL_TURNS = 8;

export interface AskAgentResult {
  answer: string;
  tokens: { input: number; output: number };
}

export interface AgentStreamCallbacks {
  /** 流式文本回调（每个 token） */
  onToken?: (text: string) => void;
  /** 工具调用日志回调 */
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  /** 工具执行结果回调 */
  onToolResult?: (name: string, summary: string) => void;
  /** 最终答案完成回调 */
  onDone?: () => void;
}

/**
 * 非交互式问答：创建 Agent，执行单轮问答，返回最终答案。
 * 适用于 `story ask <问题>` 命令。
 */
export async function askAgent(
  provider: LlmProvider,
  repo: StoryRepo,
  cfg: StoryConfig,
  question: string,
  callbacks: AgentStreamCallbacks = {}
): Promise<AskAgentResult> {
  const kit = provider.getAgentKit?.();
  if (!kit) {
    throw new Error("当前 provider 不支持 Agent 模式");
  }
  const { model, streamFn } = kit;

  // 设置 Ask 阅读进度边界：所有 repo 读方法只返回 chapter <= userChapter 的数据
  repo.setUserChapter(cfg.userChapter);

  // 创建工具上下文
  const toolCtx: NovelToolContext = {
    repo,
    book: cfg.book,
    maxChapter: cfg.maxChapter,
    userChapter: cfg.userChapter,
    focus: { from: null, to: null },
  };

  const toolCallCounter = { count: 0 };

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentSystemPrompt(cfg),
      model: model as any,
      tools: buildNovelTools(toolCtx),
    },
    streamFn: streamFn as any,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      toolCallCounter.count++;
      if (toolCallCounter.count > MAX_TOOL_TURNS) {
        return {
          block: true,
          reason: `已达到最大工具调用次数（${MAX_TOOL_TURNS}）。请停止调用工具，直接根据已获取的数据回答。若数据不足，请明确回答「当前结构化数据不足以可靠回答这个问题。」`,
          terminate: true,
        };
      }
      return undefined;
    },
  });

  // 订阅事件
  let inputTokens = 0;
  let outputTokens = 0;
  let finalAnswer = "";
  let currentToolCall: { name: string; args: Record<string, unknown> } | null = null;

  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      callbacks.onToken?.(delta);
      finalAnswer += delta;
    }
    if (event.type === "message_end" && (event.message as any).role === "assistant") {
      const msg = event.message as any;
      if (msg.usage) {
        inputTokens += msg.usage.input ?? 0;
        outputTokens += msg.usage.output ?? 0;
      } else if (msg.stopReason === "stop" || msg.stopReason === "toolUse") {
        // 非流式路径：从 content 提取文本
        const textBlocks = (msg.content ?? []).filter((c: any) => c.type === "text");
        if (textBlocks.length && !finalAnswer) {
          finalAnswer = textBlocks.map((t: any) => t.text).join("");
        }
      }
    }
    if (event.type === "tool_execution_start") {
      currentToolCall = { name: event.toolName, args: event.args };
      callbacks.onToolCall?.(event.toolName, event.args);
    }
    if (event.type === "tool_execution_end") {
      if (currentToolCall) {
        const isError = (event as any).isError;
        const summary = isError
          ? "执行失败"
          : `完成（${((event.result?.content?.[0] as any)?.text ?? "").slice(0, 60)}...）`;
        callbacks.onToolResult?.(currentToolCall.name, summary);
        currentToolCall = null;
      }
    }
    if (event.type === "agent_end") {
      callbacks.onDone?.();
    }
  });

  try {
    // 注入当前阅读进度（每次提问都携带最新 userChapter，防止 agent 猜测边界）
    agent.steer({
      role: "user",
      content: `[系统提示] 当前阅读进度：第 ${cfg.userChapter} 章。所有工具检索结果只包含 ≤ 第 ${cfg.userChapter} 章的数据，不要提及或推测之后的内容。`,
      timestamp: Date.now(),
    } as any);
    await agent.prompt(question);
  } catch (e) {
    log(`Agent 执行出错: ${e instanceof Error ? e.message : String(e)}`);
    // 如果有 finalAnswer 就返回，否则返回错误提示
    if (!finalAnswer) {
      finalAnswer = "当前 Agent 执行过程中出现错误，无法回答。";
    }
  }

  return {
    answer: finalAnswer,
    tokens: { input: inputTokens, output: outputTokens },
  };
}

/**
 * 创建 Agent 实例（供 TUI 交互界面使用）。
 * 返回的 Agent 可以多次执行 prompt() 实现多轮对话。
 */
export function createStoryAgent(
  model: any,
  streamFn: any,
  repo: StoryRepo,
  cfg: StoryConfig,
  toolCtx: NovelToolContext
): Agent {
  // 设置 Ask 阅读进度边界
  repo.setUserChapter(cfg.userChapter);
  const toolCallCounter = { count: 0 };

  const agent = new Agent({
    initialState: {
      systemPrompt: buildAgentSystemPrompt(cfg),
      model,
      tools: buildNovelTools(toolCtx),
    },
    streamFn: streamFn as any,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      toolCallCounter.count++;
      if (toolCallCounter.count > MAX_TOOL_TURNS) {
        return {
          block: true,
          reason: `已达到最大工具调用次数（${MAX_TOOL_TURNS}）。请停止调用工具，直接根据已获取的数据回答。若数据不足，请明确回答「当前结构化数据不足以可靠回答这个问题。」`,
          terminate: true,
        };
      }
      return undefined;
    },
  });

  return agent;
}