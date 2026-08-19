// pi-tui 交互式小说问答界面
// 布局参考 Claude Code / opencode / pi code agent：
//   顶栏：书名 · 路径 ──── 章节进度 · 覆盖率
//   中间：聊天历史（ScrollView）
//   底栏：模型名 · 上下文字数 ──── 阅读进度
//   输入框：Editor（支持 / 斜杠命令自动补全）

import { Agent } from "@earendil-works/pi-agent-core";
import {
  Container,
  type MarkdownTheme,
  Markdown,
  ScrollView,
  Editor,
  type EditorTheme,
  CombinedAutocompleteProvider,
  ProcessTerminal,
  Spacer,
  Text,
  TruncatedText,
  TuiAltScreen,
  VStack,
  HStack,
  visibleWidth,
  type TUI,
  matchesKey,
  type TuiInputListenerResult,
} from "@earendil-works/pi-tui";
import { StoryRepo } from "../../db/repo.js";
import { StoryConfig } from "../../config.js";
import { LlmProvider } from "../../llm/types.js";
import { createProvider } from "../../llm/index.js";
import { createStoryAgent } from "../../reader/agent.js";
import type { NovelToolContext } from "../../reader/tools.js";
import { runSlashCommand, commandHint, SLASH_COMMANDS, UI_COMMANDS } from "./commands.js";
import { openBuildView, openLoginView, openSettingsView } from "./menus.js";
import { AskSessionLogger, logAskEvent } from "../../reader/ask-log.js";
import { estimateTokens } from "../../util.js";

// ── 简单主题 ──────────────────────────────────────

const theme: MarkdownTheme = {
  heading: (t) => `\x1b[1;36m${t}\x1b[0m`,
  link: (t) => `\x1b[4;34m${t}\x1b[0m`,
  linkUrl: (t) => `\x1b[2;34m${t}\x1b[0m`,
  code: (t) => `\x1b[33m${t}\x1b[0m`,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => `\x1b[2m${t}\x1b[0m`,
  quote: (t) => `\x1b[2;3m${t}\x1b[0m`,
  quoteBorder: (t) => `\x1b[2m${t}\x1b[0m`,
  // hr（模型输出的 --- / ──── 分隔线）渲染成轻量分隔点，避免满屏横线
  hr: () => `\x1b[2m· · · · · · · ·\x1b[0m`,
  listBullet: (t) => `\x1b[36m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  italic: (t) => `\x1b[3m${t}\x1b[0m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[0m`,
  underline: (t) => `\x1b[4m${t}\x1b[0m`,
};

const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`;
const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;

// Editor 主题（补全菜单 + 边框）
const editorTheme: EditorTheme = {
  borderColor: (t) => dim(t),
  selectList: {
    selectedPrefix: (t) => cyan(t),
    selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
    description: (t) => dim(t),
    scrollInfo: (t) => dim(t),
    noMatch: (t) => dim(t),
  },
};

// ── 应用 ──────────────────────────────────────────

export interface TuiAppOptions {
  /** 配置了 LLM 时非空；未配置（可通过 /login 配置后由 reloadLlm 创建）时为 null */
  agent: Agent | null;
  repo: StoryRepo;
  cfg: StoryConfig;
  provider: LlmProvider | null;
  /** 章节焦点引用（与 Agent 工具共享；/chapter 命令会清理它） */
  focus?: { from: number | null; to: number | null };
  /** 工具上下文可变引用（/chapter 切换时同步 userChapter；reload LLM 时用于重建 agent） */
  toolCtx: NovelToolContext;
  welcomeMessage?: string;
}

export async function runTuiApp(opts: TuiAppOptions): Promise<void> {
  const { cfg, repo, focus, toolCtx } = opts;
  // agent/provider 可变：/login 保存或 /logout 后重建并换入（LLM 配置实时生效，无需重启）
  let agent = opts.agent;
  let provider = opts.provider;
  let modelName = (agent as any)?.state?.model?.name ?? provider?.name ?? "未配置";

  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiAltScreen(terminal, undefined, undefined, {
    mouse: true,
    wheelScrollLines: 3,
  });

  // ── 组件 ──

  const chatContainer = new Container();
  const scrollView = new ScrollView(chatContainer, {
    follow: "end",
    primary: true,
    overscroll: "contain",
    scrollbar: "auto",
  });

  // Editor 支持斜杠命令自动补全
  const editor = new Editor(tui, editorTheme);
  const autocomplete = new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd());
  editor.setAutocompleteProvider(autocomplete);

  // ── 顶栏：书名 · 路径（窄终端自动截断不折行）──── 全书范围 · 覆盖率 ──

  const cov = buildCoverage(repo);
  // 注意：HStack 的 intrinsic 计算会用 render(safeWidth) 的 padding 结果导致虚高，
  // 所以右侧固定内容必须显式 basis = 可见宽度（否则 grow 失效、左侧被压到 minSize）
  const rightContent = ` ${dim(`已导入 ${cov.total} 章`)}  ${green(`已构建 ${cov.built}/${cov.total} (${cov.pct}%)`)} `;
  const topBar = new HStack([
    { component: new TruncatedText(` ${cyan(cfg.book || "（未导入）")} ${dim(`· ${process.cwd()}`)}`, 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 8 },
    { component: new Text(rightContent, 0, 0), basis: visibleWidth(rightContent), grow: 0, shrink: 0 },
  ], { gap: 1, align: "center" });

  // ── 底栏：模型 ──── 上下文 ──── 进度 ──

  const statusText = new Text("", 1, 0);
  const bottomBar = new HStack([
    { component: statusText, basis: 0, grow: 1 },
  ], { gap: 0, align: "center" });

  function updateStatusBar(): void {
    const msgCount = (agent?.state.messages ?? []).length;
    let totalTokens = 0;
    // 粗略估算：用最后几条消息估算平均 token 数
    const recentMsgs = (agent?.state.messages ?? []).slice(-3);
    for (const m of recentMsgs) {
      try {
        totalTokens += estimateTokens(JSON.stringify(m));
      } catch { totalTokens += 50; }
    }
    const avgToken = recentMsgs.length > 0 ? Math.round(totalTokens / recentMsgs.length) : 0;
    const estimatedTotal = msgCount * avgToken;
    const ctxStr = estimatedTotal > 1000 ? `${(estimatedTotal / 1000).toFixed(1)}k` : `${estimatedTotal}`;
    statusText.setText(
      `模型: ${dim(modelName)}  ·  上下文: ${dim(ctxStr)}  ·  阅读进度: 第 ${cyan(`${cfg.userChapter}`)} 章`
    );
    tui.requestRender();
  }

  // 代理事件订阅：每次消息更新后刷新底栏（reload 时重订阅新 agent）
  let statusUnsubscribe: (() => void) | undefined;
  if (agent) {
    statusUnsubscribe = agent.subscribe((event) => {
      if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
        updateStatusBar();
      }
    });
  }

  /** LLM 配置变更后重建 provider + agent 并实时换入（/login 保存 / /logout 后调用） */
  async function reloadLlm(): Promise<{ ok: boolean; error?: string; mode?: "llm" }> {
    try {
      const newProvider = createProvider(cfg); // 未配置连接 → 抛错
      const kit = newProvider.getAgentKit?.();
      const newAgent = kit ? createStoryAgent(kit.model, kit.streamFn, repo, cfg, toolCtx) : null;
      // 停掉旧 agent 在途执行并退订，换入新 agent/provider
      try { agent?.abort(); } catch { /* 无在途任务时忽略 */ }
      if (statusUnsubscribe) statusUnsubscribe();
      agent = newAgent;
      provider = newProvider;
      modelName = (agent as any)?.state?.model?.name ?? provider?.name ?? "未配置";
      statusUnsubscribe = undefined;
      if (agent) {
        statusUnsubscribe = agent.subscribe((event) => {
          if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
            updateStatusBar();
          }
        });
      }
      updateStatusBar();
      tui.requestRender();
      return { ok: true, mode: "llm" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 界面化命令（/login 等）完成后向聊天区输出摘要
  function notifyChat(text: string): void {
    chatContainer.addChild(new Markdown(text, 1, 0, theme));
    chatContainer.addChild(new Spacer(1));
    tui.requestRender();
  }

  // ── 布局 ──

  // Layout: topBar (auto) + chat history (grow) + editor (auto) + bottomBar (auto)
  const layout = new VStack([
    { component: topBar, basis: "auto", grow: 0, shrink: 0 },
    { component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: editor, basis: "auto", grow: 0, shrink: 0, minSize: 3 },
    { component: bottomBar, basis: "auto", grow: 0, shrink: 0 },
  ]);
  (tui as any).setLayoutRoot(layout);

  // ── 欢迎消息 ──

  const welcome =
    opts.welcomeMessage ??
    buildWelcome(repo);

  chatContainer.addChild(new Markdown(welcome, 1, 1, theme));
  chatContainer.addChild(new Spacer(1));
  updateStatusBar();
  tui.requestRender();

  // ── 处理输入 ──

  let busy = false;

  editor.onSubmit = async (text: string) => {
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    // 记录历史：↑/↓ 可在输入框浏览之前提交的命令/问题（Editor 原生支持）
    editor.addToHistory(trimmed);

    busy = true;

    // 斜杠命令提前解析：UI 命令（/settings /login /build）不在聊天区留下回显
    const isSlash = trimmed.startsWith("/");
    const cmd = isSlash ? (trimmed.split(/\s+/)[0]?.toLowerCase() ?? "") : "";
    const isUiCmd = isSlash && UI_COMMANDS.has(cmd.slice(1));

    // 界面化命令能力（/settings /login /build /logout 的 reload）
    const ui = {
      // 延迟到当前 onSubmit 完成之后再切布局：onSubmit 末尾会无条件 setFocus(editor)，
      // 若同步切换会把焦点抢回不可见的编辑器（方向键失效）。setTimeout(0) 让
      // showModalView 的 setFocus(列表) 成为最后一次焦点设置。
      openSettings: () => {
        setTimeout(
          () => openSettingsView(tui, { cfg, repo, toolCtx, focus, agent, onNotify: notifyChat, topBar, scrollView, layoutRoot: layout, focusTarget: editor }),
          0
        );
      },
      openLogin: () => {
        setTimeout(
          () => openLoginView(tui, { cfg, repo, toolCtx, focus, agent, onNotify: notifyChat, topBar, scrollView, layoutRoot: layout, focusTarget: editor, onLlmChanged: reloadLlm }),
          0
        );
      },
      openBuild: (hooks: { onCancel: () => void }) =>
        openBuildView(tui, { cfg, repo, toolCtx, focus, agent, onNotify: notifyChat, topBar, scrollView, layoutRoot: layout, focusTarget: editor }, hooks),
      reloadLlm,
    };

    // 用户消息
    if (!isUiCmd) {
      chatContainer.addChild(new Text(cyan(`▶ 你：${trimmed}`), 1, 0));
      chatContainer.addChild(new Spacer(1));
    }

    // ── 斜杠命令 ──
    if (isSlash) {

      // 内置命令（TUI 层处理）
      if (cmd === "/clear") {
        chatContainer.clear();
        chatContainer.addChild(new Markdown(welcome, 1, 1, theme));
        chatContainer.addChild(new Spacer(1));
        busy = false;
        tui.setFocus(editor);
        tui.requestRender();
        return;
      }
      if (cmd === "/exit") {
        agent?.abort();
        tui.stop();
        process.exit(0);
        return;
      }

      // UI 命令（/settings /login /build）：面板接管一切，聊天区零痕迹（无回显、无"执行中…"）
      if (isUiCmd) {
        try {
          await runSlashCommand(trimmed, { repo, cfg, provider, focus, toolCtx, agent, onNotify: notifyChat, ui });
        } catch (e: any) {
          notifyChat(red(`命令执行出错：${e.message ?? String(e)}`));
        }
        busy = false;
        tui.setFocus(editor);
        updateStatusBar();
        tui.requestRender();
        return;
      }

      // 普通命令：流式渲染到聊天区
      const streamSlot = new Container();
      const thinkingLine = new Text(dim("⏳ 执行中..."), 1, 0);
      streamSlot.addChild(thinkingLine);
      chatContainer.addChild(streamSlot);
      tui.requestRender();

      let hasProgress = false;
      let noEcho = false;

      try {
        const result = await runSlashCommand(trimmed, {
          repo, cfg, provider, focus, toolCtx, agent,
          onNotify: notifyChat,
          onProgress: (text) => {
            if (!hasProgress) {
              hasProgress = true;
              try { streamSlot.removeChild(thinkingLine); } catch { }
              streamSlot.clear();
            } else {
              streamSlot.clear();
            }
            streamSlot.addChild(new Markdown(text, 1, 0, theme));
            tui.requestRender();
          },
          ui,
        });
        if (hasProgress) {
          streamSlot.clear();
        } else {
          try { streamSlot.removeChild(thinkingLine); } catch { }
        }
        if (result?.noEcho) {
          noEcho = true;
          // UI 命令（/settings /login）：连临时槽位一并移除，聊天区不留任何痕迹
          try { chatContainer.removeChild(streamSlot); } catch { }
        } else if (result) {
          // suggestClear：章节切换时清空聊天界面
          if (result.suggestClear) {
            chatContainer.clear();
            chatContainer.addChild(new Markdown(welcome, 1, 1, theme));
            chatContainer.addChild(new Spacer(1));
          }
          streamSlot.addChild(new Markdown(result.text, 1, 0, theme));
          if (result.suggestReload) {
            streamSlot.addChild(new Text(dim("⚠️ 数据已更新，建议重新进入 TUI 以加载最新数据。"), 1, 0));
          }
        } else {
          streamSlot.addChild(new Markdown(
            `未知命令：\`${cmd}\`。${commandHint()}`,
            1, 0, theme
          ));
        }
      } catch (e: any) {
        if (hasProgress) streamSlot.clear();
        else try { streamSlot.removeChild(thinkingLine); } catch { }
        streamSlot.addChild(new Markdown(red(`命令执行出错：${e.message ?? String(e)}`), 1, 0, theme));
      }
      if (!noEcho) {
        chatContainer.addChild(new Spacer(1));
      }
      busy = false;
      tui.setFocus(editor);
      updateStatusBar();
      tui.requestRender();
      return;
    }

    // ── Agent 问答 ──
    if (agent === null) {
      // 未配置 LLM：提示用 /login 配置（不进入 agent 流程）
      notifyChat(red("⚠️ LLM 未配置，无法问答。\n\n输入 `/login` 打开引导向导（baseUrl → apiKey → model → thinkingFormat → 测试 → 保存），保存后立即生效。"));
      busy = false;
      tui.setFocus(editor);
      updateStatusBar();
      tui.requestRender();
      return;
    }

    const streamSlot = new Container();
    const thinkingLine = new Text(dim("⏳ 思考中..."), 1, 0);
    streamSlot.addChild(thinkingLine);
    chatContainer.addChild(streamSlot);
    tui.requestRender();

    let answerText = "";
    let answerComponent: Markdown | null = null;
    // 最终消息兜底文本（非流式 / 推理模型把回答放 thinking 时用）；不中途渲染，agent 结束才用
    let finalFallbackText = "";
    // 工具调用统计（空回答诊断时展示，帮助理解模型行为）
    let toolCalls = 0;
    let toolFailures = 0;
    let lastFailedTool = "";
    // Ask 会话日志（.story/logs/ask/），排查模型空回答/卡住/工具异常用
    const askLog = new AskSessionLogger();
    const askStart = Date.now();
    askLog.log({ kind: "question", text: trimmed, meta: { userChapter: cfg.userChapter, book: cfg.book } });

    // 思考中存活指示：每 3s 更新一次已等待时长，避免"不知道还在不在跑"
    let thinkElapsed = 0;
    const thinkTimer = setInterval(() => {
      thinkElapsed += 3;
      thinkingLine.setText(dim(`⏳ 思考中…（${thinkElapsed}s）`));
      tui.requestRender();
    }, 3000);

    // 把正在渲染的回答移到流最底：保证所有工具行（🔧/✓）聚在一起、最终回答在最后
    const moveAnswerToEnd = (): void => {
      if (answerComponent) {
        try { streamSlot.removeChild(answerComponent); } catch { }
        streamSlot.addChild(answerComponent);
      }
    };

    const unsubscribe = agent.subscribe((event) => {
      logAskEvent(askLog, event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        answerText += event.assistantMessageEvent.delta;
        if (answerComponent === null) {
          streamSlot.removeChild(thinkingLine);
          answerComponent = new Markdown(answerText, 1, 0, theme);
          streamSlot.addChild(answerComponent);
        } else {
          answerComponent.setText(answerText);
        }
        tui.requestRender();
      }
      if (event.type === "message_end" && (event.message as any).role === "assistant") {
        // 记录最终消息的文本（content 空时用 thinking 兜底），但【不立即渲染】——
        // 避免把中间消息/推理内容提前当"最终回答"渲染到工具调用之前
        const msg = event.message as any;
        const textBlocks = (msg.content ?? []).filter((c: any) => c.type === "text");
        let full = textBlocks.map((t: any) => t.text).join("");
        if (!full) {
          const thinkBlocks = (msg.content ?? []).filter((c: any) => c.type === "thinking");
          full = thinkBlocks.map((t: any) => t.thinking ?? "").join("");
        }
        if (full) finalFallbackText = full; // 最后一条助手消息覆盖前面的
      }
      if (event.type === "tool_execution_start") {
        toolCalls++;
        const args = typeof event.args === "object" ? JSON.stringify(event.args) : String(event.args);
        streamSlot.addChild(new Text(dim(`  🔧 ${event.toolName}(${truncate(args, 60)})`), 1, 0));
        // 若回答已在流式渲染中，把它移到最底：保证「工具调用在前、最终回答在后」的呈现顺序
        moveAnswerToEnd();
        tui.requestRender();
      }
      if (event.type === "tool_execution_end") {
        const isError = (event as any).isError;
        if (isError) { toolFailures++; lastFailedTool = event.toolName; }
        streamSlot.addChild(new Text(dim(`    ${isError ? "✗ 失败" : "✓ 完成"}`), 1, 0));
        // 工具 end 也可能晚于回答文本到达（模型同轮先答后调工具）——把回答移到 ✓ 之后
        moveAnswerToEnd();
        tui.requestRender();
      }
    });

    try {
      // 注入当前阅读进度
      agent.steer({
        role: "user",
        content: `[系统提示] 当前阅读进度：第 ${cfg.userChapter} 章。所有工具检索结果只包含 ≤ 第 ${cfg.userChapter} 章的数据，不要提及或推测之后的内容。`,
        timestamp: Date.now(),
      } as any);
      // 每题提问（无工具调用上限，由模型/上下文自然收敛）
      await agent.prompt(trimmed);
      // 空回答二次机会：模型可能检索到数据后忘了总结（或工具调用失败后直接返回空）——
      // 追加一条明确指令，要求它基于已检索数据回答或明确说数据不足（禁止再调工具、禁止空内容）
      if (answerComponent === null && toolCalls > 0 && !finalFallbackText) {
        await agent.prompt(
          "请直接根据你刚才通过工具检索到的数据回答我上一个问题。能回答就给出简明答案；数据不足就明确说「当前结构化数据不足以可靠回答这个问题。」不要调用任何工具，也不要输出空内容。"
        );
      }
    } catch (e: any) {
      if (answerComponent === null) {
        streamSlot.removeChild(thinkingLine);
        answerComponent = new Markdown(red(`Agent 执行出错：${e.message ?? String(e)}`), 1, 0, theme);
        streamSlot.addChild(answerComponent);
      } else {
        answerText += `\n\n${red(`Agent 执行出错：${e.message ?? String(e)}`)}`;
        (answerComponent as Markdown).setText(answerText);
      }
    } finally {
      unsubscribe();
      clearInterval(thinkTimer);
    }

    // 结束兜底：全程无流式文本时，用最终消息的文本/thinking（非流式 / 推理模型）——此时工具调用已渲染在前
    if (answerComponent === null && finalFallbackText) {
      answerText = finalFallbackText;
      try { streamSlot.removeChild(thinkingLine); } catch { }
      answerComponent = new Markdown(finalFallbackText, 1, 0, theme);
      streamSlot.addChild(answerComponent);
      tui.requestRender();
    } else if (answerComponent === null) {
      // 工具调用后模型始终未返回任何文本（空响应）——给出明确提示（含工具调用统计），而不是一直挂着"思考中"
      const toolInfo = toolCalls > 0
        ? `模型进行了 ${toolCalls} 次工具调用，其中 ${toolFailures} 次失败${lastFailedTool ? `（如 \`${lastFailedTool}\`）` : ""}，之后没有生成总结。`
        : "";
      try { streamSlot.removeChild(thinkingLine); } catch { }
      answerComponent = new Markdown(
        red(`Agent 未返回文本回答：${toolInfo}\n\n可换个问法再试；工具调用失败时模型应重试或基于已有数据回答，必要时检查 LLM 配置（model / thinkingFormat）。`),
        1, 0, theme
      );
      streamSlot.addChild(answerComponent);
      tui.requestRender();
    }

    // Ask 会话日志：记录最终答案与统计（供排查）
    askLog.log({
      kind: "answer",
      text: answerText,
      meta: { fallback: finalFallbackText ? true : false, usedFallback: answerText === finalFallbackText },
    });
    askLog.log({
      kind: "end",
      toolCalls,
      toolFailures,
      durationMs: Date.now() - askStart,
      meta: { logPath: askLog.path },
    });

    // 问答完成
    chatContainer.addChild(new Spacer(1));
    busy = false;
    tui.setFocus(editor);
    updateStatusBar();
    tui.requestRender();
  };

  // ── 键盘处理 ──

  tui.addInputListener((data): TuiInputListenerResult => {
    if (matchesKey(data, "ctrl+c")) {
      agent?.abort();
      tui.stop();
      process.exit(0);
    }
    if (matchesKey(data, "ctrl+l")) {
      chatContainer.clear();
      chatContainer.addChild(new Markdown(welcome, 1, 1, theme));
      chatContainer.addChild(new Spacer(1));
      updateStatusBar();
      tui.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  // ── 启动 ──

  tui.setFocus(editor);
  tui.start();

  // 保持进程存活直到 Ctrl+C 退出
  await new Promise<void>(() => {});
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * 生成默认欢迎语：不硬编码任何具体小说。
 * - 已导入未构建 → 提示 /build；
 * - 已构建且当前阅读进度内有实体 → 用真实角色名生成示例问题（Reader 可见性过滤，不剧透未来内容）；
 * - 未导入 / 无可查询实体 → 通用引导。
 */
export function buildWelcome(repo: StoryRepo): string {
  const lines = ["欢迎来到小说助手。"];
  const chapters = repo.countChapters();
  const built = repo.listBatches().some((b) => b.status === "done");
  if (chapters === 0) {
    lines.push("", "还没有导入小说：输入 `/import <小说文件路径>` 导入整本，再 `/build` 构建知识。");
  } else if (!built) {
    lines.push("", `小说已导入（共 ${chapters} 章），但还没有构建知识：输入 \`/build\` 开始抽取结构化数据。`);
  } else {
    const entities = repo.listEntities().slice(0, 5);
    if (entities.length > 0) {
      const a = entities[0].name;
      const b = entities[1]?.name;
      const qs = [`「${a}是谁」`];
      if (b) qs.push(`「${b}和${a}是什么关系」`);
      qs.push("「有哪些人物」", "「我现在读到哪了」");
      lines.push("", `在下方输入问题，比如 ${qs.join("、")}。`);
    } else {
      lines.push("", "当前阅读进度内还没有可查询的人物：用 `/chapter <N>` 调整阅读进度，或先 `/build` 构建。");
    }
  }
  lines.push("", "`Ctrl+C` 退出，`Ctrl+L` 清屏。");
  return lines.join("\n");
}

function buildCoverage(repo: StoryRepo): { total: number; built: number; pct: number } {
  try {
    const chapters = repo.countChapters();
    const dbMax = repo.availableThrough() ?? 0;
    const batches = repo.listBatches();
    const doneChapters = new Set<number>();
    for (const b of batches) {
      if (b.status !== "done") continue;
      const [s, e] = b.range.split("-").map(Number);
      if (isNaN(s) || isNaN(e)) continue;
      for (let c = s; c <= e; c++) doneChapters.add(c);
    }
    const built = doneChapters.size;
    const total = dbMax || chapters;
    const pct = total > 0 ? Math.round((built / total) * 100) : 0;
    return { total, built, pct };
  } catch {
    return { total: 0, built: 0, pct: 0 };
  }
}