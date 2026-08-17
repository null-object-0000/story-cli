// story ask <问题>：仅基于结构化数据的无剧透问答
// 模式：
//   LLM mode → 基于 pi-agent-core 的 Agent 驱动（工具调用 + 流式输出）
//   Mock mode → 模板回答器（离线验证管道）

import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { createProvider } from "../llm/index.js";
import { answerQuestion, recordAskLog } from "../ask/answer.js";
import { askAgent } from "../agent/agent.js";
import { log, warn } from "../logger.js";

export async function cmdAsk(question: string, flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  try {
    const providerFlag = flags["--provider"];
    if (providerFlag && providerFlag !== "openai" && providerFlag !== "mock") {
      throw new Error(`--provider 可选值为 openai|mock，收到：${providerFlag}`);
    }
    const { provider, mode } = createProvider(cfg, providerFlag as any | undefined);
    if (mode === "mock") {
      warn("未检测到 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL，使用内置模板回答器（离线模式）。配置后可获得更自然的回答。");
    }

    // 设置 Ask 阅读进度边界：所有检索只返回 chapter <= userChapter 的数据（防剧透）
    repo.setUserChapter(cfg.userChapter);

    const t0 = Date.now();
    let streamed = false;

    // 判断是否使用 Agent 模式（LLM mode + provider 支持 getAgentKit）
    const kit = mode === "llm" ? provider.getAgentKit?.() : null;

    if (kit) {
      // ── Agent 驱动 ──
      const result = await askAgent(
        provider,
        repo,
        cfg,
        question,
        {
          onToken: (text) => {
            if (!streamed) {
              streamed = true;
            }
            process.stdout.write(text);
          },
          onToolCall: (name, args) => {
            const argsStr = JSON.stringify(args);
            log(`[agent] ${name}(${truncate(argsStr, 80)})`);
          },
          onToolResult: (name, summary) => {
            log(`[agent]   ${name} → ${summary}`);
          },
        }
      );
      if (streamed) process.stdout.write("\n");

      const durationMs = Date.now() - t0;
      recordAskLog({
        repo,
        providerName: provider.name,
        question,
        answer: result.answer,
        durationMs,
        tokens: result.tokens,
      });

      if (!streamed) {
        log(result.answer);
      }
    } else {
      // ── 传统管道（LLM 无 agent 支持 或 mock 模式） ──
      const result = await answerQuestion({
        repo,
        cfg,
        provider,
        mode,
        question,
        onReady: (info) => {
          log(`[intent] ${info.intent}`);
          if (info.entities.length) log(`[entities] ${info.entities.join("、")}`);
          log("");
        },
        onToken: (text) => {
          if (!streamed) {
            streamed = true;
          }
          process.stdout.write(text);
        },
      });
      if (streamed) process.stdout.write("\n");
      const durationMs = Date.now() - t0;

      if (mode === "llm") {
        recordAskLog({
          repo,
          providerName: provider.name,
          question,
          answer: result.answer,
          durationMs,
          tokens: result.tokens,
        });
      }

      if (!streamed) {
        log(result.answer);
      }
    }

    return 0;
  } finally {
    repo.close();
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}