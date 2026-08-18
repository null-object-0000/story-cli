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

  const repo = new StoryRepo(dbPath());

  try {
    const providerFlag = flags["--provider"];
    if (providerFlag && providerFlag !== "openai" && providerFlag !== "mock") {
      throw new Error(`--provider 可选值为 openai|mock，收到：${providerFlag}`);
    }

    const { provider, mode } = createProvider(cfg, providerFlag as any | undefined);
    const offline = mode === "mock";
    if (offline) {
      warn("LLM 未配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）：Agent 问答暂不可用，进入「未配置」状态");
      warn("  在 TUI 内输入 /config llm 配置端点 / Key / 模型，保存后重启 story tui 即可问答；/build /status 等命令照常可用。");
    }

    const toolCtx: NovelToolContext = {
      repo,
      book: cfg.book,
      availableThrough: repo.availableThrough() ?? 0,
      userChapter: cfg.userChapter,
      focus: { from: null, to: null },
    };

    // 有真实 LLM（getAgentKit）→ 正常 Agent；否则用离线 Agent 也能进入 TUI
    const kit = provider.getAgentKit?.();
    const agent = kit ? createStoryAgent(kit.model, kit.streamFn, repo, cfg, toolCtx) : createOfflineAgent(repo, cfg, toolCtx);

    const offlineWelcome = [
      "**LLM 未配置**：Agent 问答暂不可用，但这不阻碍你使用其它功能。",
      "",
      "直接在此输入 `/config llm` 查看 LLM 配置组，或用：",
      "- `/config llm.baseUrl=http://127.0.0.1:18640/v1`",
      "- `/config llm.apiKey=sk-xxx`",
      "- `/config llm.model=deepseek-chat`",
      "",
      "保存后**重启 story tui** 即可问答。其它命令照常可用：`/status`、`/chapter <N>`、`/review`、`/audit`、`/help`。",
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