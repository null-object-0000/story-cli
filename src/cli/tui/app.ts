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
import { runSlashCommand, commandHint, SLASH_COMMANDS } from "./commands.js";
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
  hr: (t) => `\x1b[2m${t}\x1b[0m`,
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
  agent: Agent;
  repo: StoryRepo;
  cfg: StoryConfig;
  provider: LlmProvider | null;
  /** 章节焦点引用（与 Agent 工具共享；/chapter 命令会清理它） */
  focus?: { from: number | null; to: number | null };
  /** 工具上下文可变引用（/chapter 切换时同步 userChapter，使 get_progress 返回新值） */
  toolCtx?: { userChapter: number; focus: { from: number | null; to: number | null } };
  welcomeMessage?: string;
}

export async function runTuiApp(opts: TuiAppOptions): Promise<void> {
  const { agent, cfg, provider, repo, focus, toolCtx } = opts;

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

  const modelName = (agent.state as any).model?.name ?? provider?.name ?? "unknown";
  const cov = buildCoverage(repo);
  // 注意：HStack 的 intrinsic 计算会用 render(safeWidth) 的 padding 结果导致虚高，
  // 所以右侧固定内容必须显式 basis = 可见宽度（否则 grow 失效、左侧被压到 minSize）
  const rightContent = ` ${dim(`已导入 ${cov.total} 章`)}  ${green(`已构建 ${cov.built}/${cov.total} (${cov.pct}%)`)} `;
  const topBar = new HStack([
    { component: new TruncatedText(` ${cyan(cfg.book)} ${dim(`· ${process.cwd()}`)}`, 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 8 },
    { component: new Text(rightContent, 0, 0), basis: visibleWidth(rightContent), grow: 0, shrink: 0 },
  ], { gap: 1, align: "center" });

  // ── 底栏：模型 ──── 上下文 ──── 进度 ──

  const statusText = new Text("", 1, 0);
  const bottomBar = new HStack([
    { component: statusText, basis: 0, grow: 1 },
  ], { gap: 0, align: "center" });

  function updateStatusBar(): void {
    const msgCount = (agent.state.messages ?? []).length;
    let totalTokens = 0;
    // 粗略估算：用最后几条消息估算平均 token 数
    const recentMsgs = (agent.state.messages ?? []).slice(-3);
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

  // 代理事件订阅：每次消息更新后刷新底栏
  agent.subscribe((event) => {
    if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
      updateStatusBar();
    }
  });

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
    `欢迎来到小说助手。\n\n在下方输入问题，比如「闻人佑是谁」「陈伶有什么能力」「那个拉板车的人是谁」。\n\n\`Ctrl+C\` 退出，\`Ctrl+L\` 清屏。`;

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

    // 用户消息
    chatContainer.addChild(new Text(cyan(`▶ 你：${trimmed}`), 1, 0));
    chatContainer.addChild(new Spacer(1));

    // ── 斜杠命令 ──
    if (trimmed.startsWith("/")) {
      const cmd = trimmed.split(/\s+/)[0]?.toLowerCase();

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
        agent.abort();
        tui.stop();
        process.exit(0);
        return;
      }

      // 其他命令
      const streamSlot = new Container();
      const thinkingLine = new Text(dim("⏳ 执行中..."), 1, 0);
      streamSlot.addChild(thinkingLine);
      chatContainer.addChild(streamSlot);
      tui.requestRender();

      let hasProgress = false;

      try {
        const result = await runSlashCommand(trimmed, {
          repo, cfg, provider, focus, toolCtx, agent,
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
        });
        if (hasProgress) {
          streamSlot.clear();
        } else {
          try { streamSlot.removeChild(thinkingLine); } catch { }
        }
        if (result) {
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
      chatContainer.addChild(new Spacer(1));
      busy = false;
      tui.setFocus(editor);
      updateStatusBar();
      tui.requestRender();
      return;
    }

    // ── Agent 问答 ──
    const streamSlot = new Container();
    const thinkingLine = new Text(dim("⏳ 思考中..."), 1, 0);
    streamSlot.addChild(thinkingLine);
    chatContainer.addChild(streamSlot);
    tui.requestRender();

    let answerText = "";
    let answerComponent: Markdown | null = null;

    const unsubscribe = agent.subscribe((event) => {
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
      if (event.type === "tool_execution_start") {
        const args = typeof event.args === "object" ? JSON.stringify(event.args) : String(event.args);
        streamSlot.addChild(new Text(dim(`  🔧 ${event.toolName}(${truncate(args, 60)})`), 1, 0));
        tui.requestRender();
      }
      if (event.type === "tool_execution_end") {
        const isError = (event as any).isError;
        streamSlot.addChild(new Text(dim(`    ${isError ? "✗ 失败" : "✓ 完成"}`), 1, 0));
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
      await agent.prompt(trimmed);
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
    }

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
      agent.abort();
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