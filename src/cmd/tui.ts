// story tui：交互式小说问答界面（基于 pi-tui + pi-agent）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { createProvider } from "../llm/index.js";
import { createStoryAgent } from "../agent/agent.js";
import { NovelToolContext } from "../agent/tools.js";
import { runTuiApp } from "../tui/app.js";
import { warn, log } from "../logger.js";

export async function cmdTui(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);

  try {
    const providerFlag = flags["--provider"];
    if (providerFlag && providerFlag !== "openai" && providerFlag !== "mock") {
      throw new Error(`--provider 可选值为 openai|mock，收到：${providerFlag}`);
    }

    const { provider, mode } = createProvider(cfg, providerFlag as any | undefined);
    if (mode === "mock") {
      warn("TUI 模式需要真实 LLM（配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），当前为离线模式。");
      warn("TUI 界面将启动，但 Agent 无法使用，请先配置 LLM 环境变量。");
      // 尝试继续 — agent 创建时会失败
    }

    const kit = provider.getAgentKit?.();
    if (!kit) {
      log("当前 provider 不支持 Agent 模式。TUI 需要真实 LLM（openai-compatible）。");
      log("请设置 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL 环境变量。");
      return 1;
    }

    const toolCtx: NovelToolContext = {
      repo,
      book: cfg.book,
      maxChapter: cfg.maxChapter,
      userChapter: cfg.userChapter,
      focus: { from: null, to: null },
    };

    const agent = createStoryAgent(kit.model, kit.streamFn, repo, cfg, toolCtx);

    await runTuiApp({
      agent,
      repo,
      cfg,
      provider,
      focus: toolCtx.focus,
      toolCtx,
    });

    return 0;
  } finally {
    repo.close();
  }
}