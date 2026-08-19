// story ask <问题>：仅基于结构化数据的无剧透问答
// 只走真实 LLM：provider 支持 getAgentKit → Agent 驱动；否则回退传统管道（真实 LLM 无 Agent 支持）。

import { loadConfig, dbPath } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { createProvider } from "../../llm/index.js";
import { answerQuestion, recordAskLog } from "../../reader/answer.js";
import { askAgent } from "../../reader/agent.js";
import { log } from "../../logger.js";

export async function cmdAsk(question: string, flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath());
  try {
    const provider = createProvider(cfg);

    // 阅读进度：默认用 config.userChapter；--chapter N 提供一次性临时覆盖（不写入配置）
    const userChapter = parseChapterOverride(flags) ?? cfg.userChapter;
    // 设置 Ask 阅读进度边界：所有检索只返回 chapter <= userChapter 的数据（防剧透）
    repo.setUserChapter(userChapter);

    const t0 = Date.now();
    let streamed = false;

    // Agent 驱动（provider 支持 getAgentKit）
    const kit = provider.getAgentKit?.();

    if (kit) {
      // ── Agent 驱动 ──
      const result = await askAgent(
        provider,
        repo,
        { ...cfg, userChapter },
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
      // ── 传统管道（真实 LLM 但无 Agent 支持） ──
      const result = await answerQuestion({
        repo,
        cfg: { ...cfg, userChapter },
        provider,
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
    }

    return 0;
  } finally {
    repo.close();
  }
}

/** 解析 story ask --chapter N：临时覆盖本次问答的阅读进度（不持久化） */
function parseChapterOverride(flags: Record<string, string | boolean>): number | undefined {
  const v = flags["--chapter"];
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--chapter 必须是正整数：${v}`);
  return n;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}