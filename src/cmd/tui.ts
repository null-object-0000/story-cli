// story tui：交互式小说问答界面（基于 pi-tui + pi-agent）

import { existsSync } from "node:fs";
import { loadConfig, dbPath, configPath, type StoryConfig } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { createProvider } from "../llm/index.js";
import { createStoryAgent, createOfflineAgent } from "../agent/agent.js";
import { NovelToolContext } from "../agent/tools.js";
import { runTuiApp } from "../tui/app.js";
import { confirmInit } from "../prompt.js";
import { initializeProject, logInitSummary } from "./init.js";
import { warn } from "../logger.js";

export async function cmdTui(flags: Record<string, string | boolean>): Promise<number> {
  // 未初始化时不再直接报错：询问是否初始化，选「退出」则干净退出
  let cfg: StoryConfig;
  if (!existsSync(configPath())) {
    const ok = await confirmInit();
    if (!ok) return 0;
    cfg = initializeProject({});
    logInitSummary(cfg);
  } else {
    cfg = loadConfig();
  }

  const repo = new StoryRepo(dbPath(), cfg.maxChapter);

  try {
    const providerFlag = flags["--provider"];
    if (providerFlag && providerFlag !== "openai" && providerFlag !== "mock") {
      throw new Error(`--provider 可选值为 openai|mock，收到：${providerFlag}`);
    }

    const { provider, mode } = createProvider(cfg, providerFlag as any | undefined);
    const offline = mode === "mock";
    if (offline) {
      warn("未检测到真实 LLM（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），以离线模式启动 TUI：");
      warn("  Agent 问答不可用；/stats、/context、/chapter 等命令照常可用，配置 LLM 后重启获得完整问答。");
    }

    const toolCtx: NovelToolContext = {
      repo,
      book: cfg.book,
      maxChapter: cfg.maxChapter,
      userChapter: cfg.userChapter,
      focus: { from: null, to: null },
    };

    // 有真实 LLM（getAgentKit）→ 正常 Agent；否则用离线 Agent 也能进入 TUI
    const kit = provider.getAgentKit?.();
    const agent = kit ? createStoryAgent(kit.model, kit.streamFn, repo, cfg, toolCtx) : createOfflineAgent(repo, cfg, toolCtx);

    const offlineWelcome = [
      "当前为离线（mock）模式，未配置真实 LLM。",
      "",
      "可先用不依赖 LLM 的命令浏览数据：`/stats`、`/context`、`/chapter <N>`、`/progress`、`/validate`、`/review`、`/audit`、`/help`。",
      "",
      "启用 Agent 问答：在项目根目录配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（可写 .env），然后重启 story tui。",
    ].join("\n");

    await runTuiApp({
      agent,
      repo,
      cfg,
      provider,
      focus: toolCtx.focus,
      toolCtx,
      welcomeMessage: offline ? offlineWelcome : undefined,
    });

    return 0;
  } finally {
    repo.close();
  }
}