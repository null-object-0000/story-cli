// story tui：交互式小说问答界面（基于 pi-tui + pi-agent）

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig, dbPath, configPath } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { createProvider } from "../../llm/index.js";
import type { LlmProvider } from "../../llm/types.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createStoryAgent } from "../../reader/agent.js";
import { NovelToolContext } from "../../reader/tools.js";
import { runTuiApp } from "../tui/app.js";
import { warn, log } from "../../logger.js";

export async function cmdTui(flags: Record<string, string | boolean>): Promise<number> {
  // 初始化必须有小说内容：没有项目时，在终端询问小说文件路径并自动完成 init+导入，然后进入 TUI
  if (!existsSync(configPath())) {
    const novelPath = await askNovelPath();
    if (!novelPath) return 0; // 用户取消初始化
    const { cmdInit } = await import("./init.js");
    await cmdInit({ positional: [novelPath], flags: {} });
    log("");
  }
  const cfg = loadConfig();

  const repo = new StoryRepo(dbPath());

  try {
    const toolCtx: NovelToolContext = {
      repo,
      book: cfg.book,
      availableThrough: repo.availableThrough() ?? 0,
      userChapter: cfg.userChapter,
      focus: { from: null, to: null },
    };

    let agent: Agent | null = null;
    let provider: LlmProvider | null = null;
    let welcomeMessage: string | undefined;
    try {
      // 配置了 LLM → 建真实 Agent；未配置 → 仍启动 TUI（/login 配置后 reloadLlm 建 agent）
      provider = createProvider(cfg);
      const kit = provider.getAgentKit?.();
      if (kit) agent = createStoryAgent(kit.model, kit.streamFn, repo, cfg, toolCtx);
    } catch (e) {
      warn("LLM 未配置（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）：Agent 问答暂不可用。");
      warn("  在 TUI 内输入 /login 打开引导向导配置端点 / Key / 模型，保存后立即生效（无需重启）；/status /chapter /import /settings 等命令照常可用。");
      welcomeMessage = [
        "**LLM 未配置**：Agent 问答暂不可用，但这不阻碍你使用其它功能。",
        "",
        "输入 `/login` 打开引导向导，分步填写：baseUrl → apiKey → model → thinkingFormat → 测试连接 → 保存。",
        "",
        "保存后**立即生效**（无需重启），即可开始 Agent 问答。其它命令照常可用：`/status`、`/chapter <N>`、`/import`、`/settings`（输入 `/` 可查看全部命令）。",
      ].join("\n");
    }

    await runTuiApp({
      agent,
      repo,
      cfg,
      provider,
      focus: toolCtx.focus,
      toolCtx,
      welcomeMessage,
    });

    return 0;
  } finally {
    repo.close();
  }
}

/** 未初始化时在终端询问小说文件路径（进入 TUI 之前、即 alt-screen 之前的普通终端模式）。 */
async function askNovelPath(): Promise<string | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const ans = await rl.question(
        "未找到项目配置。请输入小说文件路径进行初始化（会创建 .story 项目并导入整本小说；输入 q 或直接回车退出）：\n> "
      );
      const path = ans.trim();
      if (!path || path.toLowerCase() === "q") return null;
      if (existsSync(path)) return path;
      warn(`文件不存在：${path}，请重新输入。`);
    }
  } finally {
    rl.close();
  }
}