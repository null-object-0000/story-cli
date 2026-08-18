// Agent 组装与执行：基于 pi-agent-core 的 Agent 类，驱动小说领域工具。
// 提供两种模式：
//   1. askAgent()  — 非交互式问答（流式输出到 stdout，用于 story ask）
//   2. createAgent() — 创建 Agent 实例供 TUI 交互界面使用

import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { StoryRepo } from "../db/repo.js";
import { StoryConfig } from "../config.js";
import { LlmProvider } from "../llm/types.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { buildNovelTools, NovelToolContext } from "./tools.js";
import { AskSessionLogger, logAskEvent } from "./ask-log.js";
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
    availableThrough: repo.availableThrough() ?? 0,
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
  let lastAssistantText = ""; // 最后一条助手消息的文本/思考（非流式/推理模型兜底用）
  let currentToolCall: { name: string; args: Record<string, unknown> } | null = null;
  let toolCalls = 0;
  let toolFailures = 0;

  // Ask 会话日志（.story/logs/ask/），排查模型空回答/卡住/工具异常用
  const askLog = new AskSessionLogger();
  const askStart = Date.now();
  askLog.log({ kind: "question", text: question, meta: { userChapter: cfg.userChapter, book: cfg.book } });

  agent.subscribe((event) => {
    logAskEvent(askLog, event);
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
        let text = textBlocks.map((t: any) => t.text).join("");
        // 安全网：推理模型把整段回答放进 reasoning_content、content 为空时，用 thinking 块兜底
        if (!text) {
          const thinkBlocks = (msg.content ?? []).filter((c: any) => c.type === "thinking");
          text = thinkBlocks.map((t: any) => t.thinking ?? "").join("");
        }
        if (text) lastAssistantText = text; // 记录最后一条助手消息（工具调用消息通常无文本，最终答案消息覆盖它）
      }
    }
    if (event.type === "tool_execution_start") {
      toolCalls++;
      currentToolCall = { name: event.toolName, args: event.args };
      callbacks.onToolCall?.(event.toolName, event.args);
    }
    if (event.type === "tool_execution_end") {
      if (currentToolCall) {
        const isError = (event as any).isError;
        if (isError) toolFailures++;
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
    // 空回答二次机会：模型可能检索到数据后忘了总结（或工具调用失败后直接返回空）——
    // 追加一条明确指令，要求它基于已检索数据回答或明确说数据不足（禁止再调工具、禁止空内容）
    if (!finalAnswer && !lastAssistantText && toolCallCounter.count > 0) {
      await agent.prompt(
        "请直接根据你刚才通过工具检索到的数据回答我上一个问题。能回答就给出简明答案；数据不足就明确说「当前结构化数据不足以可靠回答这个问题。」不要调用任何工具，也不要输出空内容。"
      );
    }
  } catch (e) {
    log(`Agent 执行出错: ${e instanceof Error ? e.message : String(e)}`);
    // 如果有 finalAnswer 就返回，否则返回错误提示
    if (!finalAnswer) {
      finalAnswer = "当前 Agent 执行过程中出现错误，无法回答。";
    }
  }

  // 无流式文本（非流式/推理模型）时用最后一条助手消息的文本/思考兜底
  if (!finalAnswer && lastAssistantText) {
    finalAnswer = lastAssistantText;
  }

  // Ask 会话日志：最终答案与统计
  askLog.log({ kind: "answer", text: finalAnswer, meta: { usedFallback: finalAnswer === lastAssistantText && !!lastAssistantText } });
  askLog.log({ kind: "end", toolCalls, toolFailures, durationMs: Date.now() - askStart, meta: { logPath: askLog.path } });

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

/**
 * 离线 Agent：未配置真实 LLM（离线/mock 模式）时仍可启动 TUI。
 * streamFn 返回固定的「未配置 LLM」提示文本，不做任何工具调用；
 * 斜杠命令（/stats、/context、/chapter 等）不依赖 Agent，照常可用。
 */
export function createOfflineAgent(repo: StoryRepo, cfg: StoryConfig, toolCtx: NovelToolContext): Agent {
  return createStoryAgent(offlineModel(), offlineStreamFn, repo, cfg, toolCtx);
}

/** 离线模式下问答返回的提示文本 */
export const OFFLINE_ANSWER = [
  "当前未配置真实 LLM，无法进行 Agent 问答。",
  "",
  "在 TUI 内直接配置（无需手动改文件）：",
  "  输入 /login 打开引导向导：baseUrl → apiKey → model → 测试连接 → 保存",
  "",
  "保存后重新运行 story tui（或 npm run dev）即可启用完整问答。",
  "",
  "不依赖 LLM 的命令仍可用：/status、/chapter、/review、/audit、/help。",
].join("\n");

function offlineModel(): unknown {
  return {
    id: "offline",
    name: "offline (mock)",
    api: "openai-completions",
    provider: "offline",
  };
}

/** 生成一条合法的 AssistantMessageEventStream（start → text_* → done），内容是离线提示 */
function offlineStreamFn(model: unknown, _context: unknown, _opts?: unknown): unknown {
  // 内部 mock，事件结构只需满足 pi-agent-core 的读取要求即可
  const stream: any = createAssistantMessageEventStream();
  const text = OFFLINE_ANSWER;
  const id = (model as any)?.id ?? "offline";
  const make = (t: string) => ({
    role: "assistant",
    content: [{ type: "text", text: t }],
    api: "openai-completions",
    provider: "offline",
    model: id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const empty = make("");
  stream.push({ type: "start", partial: empty });
  stream.push({ type: "text_start", contentIndex: 0, partial: empty });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: make(text) });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: make(text) });
  stream.push({ type: "done", reason: "stop", message: make(text) });
  return stream;
}