// TUI 斜杠命令处理器：/build, /import, /validate, /review, /audit, /stats, /context, /help
// 像 Claude Code 一样，在输入框输入 /xxx 执行运维操作，结果渲染到聊天区
// 命令注册表 SLASH_COMMANDS 同时驱动 pi-tui Editor 的斜杠命令自动补全

import { StoryRepo } from "../db/repo.js";
import { StoryConfig } from "../config.js";
import { LlmProvider } from "../llm/types.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { SlashCommand } from "@earendil-works/pi-tui";

export interface CommandContext {
  repo: StoryRepo;
  cfg: StoryConfig;
  provider: LlmProvider | null;
  /** 当前章节焦点（与 Agent 工具共享引用，/chapter 切换时可清理） */
  focus?: { from: number | null; to: number | null };
  /** 工具上下文可变引用（/chapter 切换时同步 userChapter，使 get_progress 返回新值） */
  toolCtx?: { userChapter: number; focus: { from: number | null; to: number | null } };
  /** Agent 实例（/chapter 切换章节时 reset 清空消息历史，防止旧数据泄露） */
  agent?: Agent;
  /** 进度回调（build 等长任务每批完成时触发，TUI 实时更新） */
  onProgress?: (text: string) => void;
}

export interface CommandResult {
  text: string;
  suggestReload?: boolean;
  /** 建议清空聊天界面（章节切换后清空历史防止泄露） */
  suggestClear?: boolean;
}

/** 命令注册表：name/description 用于 pi-tui 输入 `/` 时的补全菜单 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "显示所有可用命令" },
  { name: "context", description: "查看工作区与会话上下文" },
  { name: "chapter", description: "查看/切换当前阅读进度（Ask 防剧透边界）", argumentHint: "<章节号>" },
  { name: "build", description: "构建知识库（LLM 抽取）", argumentHint: "[--from N] [--to N] [--force] [--parallel N]" },
  { name: "import", description: "导入小说文件（会清空现有数据）", argumentHint: "<文件路径>" },
  { name: "validate", description: "完整性校验" },
  { name: "review", description: "审核疑似重复/低置信度数据", argumentHint: "[--auto]" },
  { name: "audit", description: "防剧透审计" },
  { name: "stats", description: "数据统计" },
  { name: "progress", description: "查看结构化处理进度（已处理/未处理章节）" },
  { name: "clear", description: "清空聊天历史" },
  { name: "exit", description: "退出" },
];

/** 临时捕获 console 输出，返回给 Agent 作为工具结果（避免污染 TUI/终端） */
async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  try {
    const result = await fn();
    return { result, output: chunks.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function parseArgs(input: string): { cmd: string; flags: Record<string, string | boolean | number>; positional: string[] } {
  const parts = input.trim().split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase().replace(/^\//, "");
  const flags: Record<string, string | boolean | number> = {};
  const positional: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("--")) {
      const eq = p.indexOf("=");
      if (eq >= 0) {
        const val = parseFlagValue(p.slice(eq + 1));
        flags[p.slice(0, eq)] = val;
      } else if (i + 1 < parts.length && !parts[i + 1].startsWith("--")) {
        flags[p] = parseFlagValue(parts[i + 1]);
        i++;
      } else {
        flags[p] = true;
      }
    } else {
      positional.push(p);
    }
  }
  return { cmd, flags, positional };
}

function parseFlagValue(v: string): string | boolean | number {
  if (v === "true" || v === "false") return v === "true";
  const n = Number(v);
  if (!Number.isNaN(n) && String(n) === v) return n;
  return v;
}

export async function runSlashCommand(input: string, ctx: CommandContext): Promise<CommandResult | null> {
  const { cmd, flags, positional } = parseArgs(input);
  const { repo, cfg, provider } = ctx;

  switch (cmd) {
    // ── 帮助 ──
    case "help":
      return {
        text: [
          "## 可用命令",
          "",
          "| 命令 | 说明 |",
          "|------|------|",
          "| `/help` | 显示此帮助 |",
          "| `/context` | 查看工作区与会话上下文 |",
          "| `/chapter <N>` | 切换当前阅读进度（Ask 防剧透边界，默认第 1 章） |",
          "| `/build [--from N] [--to N] [--force] [--batch-size N] [--parallel N]` | 构建知识库（LLM 抽取，--parallel 并发数） |",
          "| `/import <path>` | 导入小说文件（注意：会清空现有数据） |",
          "| `/validate` | 完整性校验 |",
          "| `/review [--auto]` | 审核疑似重复/低置信度数据 |",
          "| `/audit` | 防剧透审计 |",
          "| `/stats` | 数据统计 |",
          "| `/progress` | 查看结构化处理进度（已处理/未处理章节） |",
          "| `/clear` | 清空聊天历史 |",
          "| `/exit` | 退出 |",
          "",
          "普通文本直接进入 Agent 问答模式。",
        ].join("\n"),
      };

    // ── 工作区上下文 ──
    case "context": {
      const c = repo.counts();
      const chapters = repo.countChapters();
      const dbMax = repo.maxChapterInDb() ?? 0;
      const focus = (ctx as any).focus ?? null;
      const focusLine = focus?.from != null
        ? `章节焦点：第 ${focus.from} ～ ${focus.to} 章`
        : "章节焦点：无（检索全部章节）";
      // 最近 5 章（在 userChapter 范围内）
      const recentChapters = repo.listChapterMeta().slice(-5);
      const recentLine = recentChapters.length
        ? `最近 5 章：${recentChapters.map((m) => `第 ${m.chapter} 章 ${m.title}`).join("、")}`
        : "最近 5 章：无";

      return {
        text: [
          `## 工作区：${cfg.book}`,
          "",
          "| 项目 | 数值 |",
          "|------|------|",
          `| 数据库总章节 | ${chapters} / ${cfg.maxChapter} |`,
          `| 当前阅读进度 | **第 ${cfg.userChapter} 章**（/chapter 切换） |`,
          `| 实体 | ${c.entities} |`,
          `| 事实 | ${c.facts} |`,
          `| 关系 | ${c.relations} |`,
          `| 能力 | ${c.abilities} |`,
          `| 事件 | ${c.events} |`,
          `| 记忆锚点 | ${c.memoryAnchors} |`,
          `| 疑似重复 | ${c.pendingDuplicates} |`,
          `| 低置信度事实 | ${c.lowConfidenceFacts} |`,
          `| 开放冲突 | ${c.openConflicts} |`,
          "",
          focusLine,
          recentLine,
          provider ? "**LLM 已配置**" : "**LLM 未配置**（mock 模式）",
        ].join("\n"),
      };
    }

    // ── 切换阅读进度 ──
    case "chapter": {
      const nArg = positional[0] || (typeof flags["--set"] === "number" ? flags["--set"] as number : null);
      if (nArg === null) {
        return { text: `当前阅读进度：**第 ${cfg.userChapter} 章**。\n\n用法：\`/chapter <章节号>\` 设置，所有检索只返回 ≤ 该章的数据。\n例如：\`/chapter 433\` 表示读到第 433 章。` };
      }
      const n = typeof nArg === "number" ? nArg : parseInt(String(nArg), 10);
      if (!Number.isInteger(n) || n < 1) {
        return { text: `无效章节号：${nArg}，请输入正整数。` };
      }
      const dbMax = repo.maxChapterInDb() ?? cfg.maxChapter;
      const max = Math.max(cfg.maxChapter, dbMax);
      if (n > max) {
        return { text: `章节号 ${n} 超过最大章节 ${max}。` };
      }
      // 更新 config
      cfg.userChapter = n;
      const { saveConfig } = await import("../config.js");
      saveConfig(cfg);
      // 更新 repo 过滤边界 — 实时生效（repo 是同一引用）
      repo.setUserChapter(n);
      // 更新工具上下文 userChapter（使 agent 的 get_progress 工具返回新值）
      if (ctx.toolCtx) ctx.toolCtx.userChapter = n;
      // 清空 Agent 消息历史 — 防止之前章节看到的数据（如第 300 章时的完整别名）通过历史泄露
      if (ctx.agent) {
        ctx.agent.reset();
      }
      // 如果焦点超出新边界，清理焦点（原地修改，保持与 Agent 工具共享的引用）
      if (ctx.focus && ctx.focus.to !== null && ctx.focus.to > n) {
        ctx.focus.from = null;
        ctx.focus.to = null;
      }
      return { text: `✅ 阅读进度已切换为 **第 ${n} 章**（对话已重置，之前的上下文已清除）。\n\n之后所有检索只返回 ≤ 第 ${n} 章的数据。\n> 当前工作区过滤边界：${repo.userChapter} 章（${repo.userChapter < cfg.maxChapter ? `收窄，仅 ${repo.userChapter} 章前数据可见` : '全量数据可见'}）\n> 注意：这不会影响已构建的结构化数据，只是 Ask 检索的过滤边界。`, suggestClear: true };
    }

    // ── 构建知识库 ──
    case "build": {
      if (!provider) {
        return { text: "未配置 LLM，无法执行构建。请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（可写入 .env 文件）。" };
      }
      const chapters = repo.countChapters();
      if (chapters === 0) {
        return { text: "chapters 为空，请先 `/import` 导入小说文件。" };
      }
      const { runBuild } = await import("../build/pipeline.js");

      // 进度回调：每批开始/完成时更新 TUI（使用 ctx.onProgress 流式渲染）
      const batchResults: { range: string; status: string; }[] = [];
      const onProgress = ctx.onProgress
        ? (p: import("../build/pipeline.js").BuildProgress) => {
            // 记录批次状态（range 为空表示"无待处理"的初始化事件，跳过）
            if (p.range) {
              const idx = batchResults.findIndex((b) => b.range === p.range);
              if (idx >= 0) batchResults[idx] = { range: p.range, status: p.status };
              else batchResults.push({ range: p.range, status: p.status });
            }

            const pct = p.totalCount > 0 ? Math.round((p.doneCount / p.totalCount) * 100) : 0;
            const barWidth = 20;
            const filled = Math.round((pct / 100) * barWidth);
            const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

            const lines = [`## 🔨 构建中`, ``];
            if (p.totalCount === 0) {
              lines.push("无待处理批次（全部已完成？可用 `--force` 强制重跑）");
            } else {
              lines.push(`\`${bar}\` **${pct}%**（${p.doneCount}/${p.totalCount} 批）`);
            }
            if (p.failedCount > 0) lines.push(`> ⚠️ ${p.failedCount} 批失败`);
            lines.push("");
            // 正在处理（LLM 调用中）
            if (p.running.length > 0) {
              lines.push(`**正在处理：** ${p.running.map((r) => `[${r}]`).join(" ")} ⏳`);
              lines.push("");
            }
            // 已完成/失败批次（最近 10 条）
            const settled = batchResults.filter((b) => b.status !== "running" && b.status !== "pending").slice(-10);
            if (settled.length > 0) {
              for (const b of settled) {
                const icon = b.status === "done" ? "✅" : "❌";
                lines.push(`- ${icon} [${b.range}]`);
              }
              if (settled.length < batchResults.filter((b) => b.status !== "running").length) {
                lines.push(`... 共 ${batchResults.length} 批`);
              }
            } else {
              lines.push("> 第一批尚未完成，请稍候...");
            }
            ctx.onProgress!(lines.join("\n"));
          }
        : undefined;

      const { result, output } = await captureConsole(() =>
        runBuild(repo, provider, {
          fromChapter: typeof flags["--from"] === "number" ? flags["--from"] as number : undefined,
          toChapter: typeof flags["--to"] === "number" ? flags["--to"] as number : undefined,
          force: flags["--force"] === true,
          batchSize: typeof flags["--batch-size"] === "number" ? flags["--batch-size"] as number : undefined,
          maxChapter: cfg.maxChapter,
          concurrency: typeof flags["--parallel"] === "number" ? flags["--parallel"] as number : undefined,
          onProgress,
        })
      );
      const summary = [`## Build 完成`];
      const done = result.processed.filter((b) => b.status === "done");
      const failed = result.processed.filter((b) => b.status !== "done");
      summary.push(`处理 ${result.processed.length} 批，跳过 ${result.skipped} 批，失败 ${failed.length} 批。`);
      if (done.length > 0) {
        summary.push("");
        summary.push("### 成功批次");
        summary.push("| 区间 | 实体 | 别名 | 事实 | 关系 | 能力 | 事件 | 锚点 |");
        summary.push("|------|------|------|------|------|------|------|------|");
        for (const b of done) {
          summary.push(`| ${b.range} | +${b.newEntities} | ${b.aliases} | ${b.facts} | ${b.relations} | ${b.abilities} | ${b.events} | ${b.memoryAnchors} |`);
        }
      }
      if (failed.length > 0) {
        summary.push("");
        summary.push("### 失败批次");
        for (const b of failed) summary.push(`- ${b.range} ❌`);
        summary.push("\n可用 `/build --force` 重跑失败区间。");
      }
      if (result.skipped > 0) {
        summary.push(`\n> 已跳过 ${result.skipped} 个已完成批次（使用 \`--force\` 可强制重跑）`);
      }
      return { text: summary.join("\n") };
    }

    // ── 导入小说 ──
    case "import": {
      const path = positional[0] || (typeof flags["--path"] === "string" ? flags["--path"] : "");
      if (!path) {
        return { text: "用法：`/import <小说文件路径>` 或 `/import --path=<路径>`" };
      }
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const absPath = existsSync(path) ? path : join(process.cwd(), path);
      if (!existsSync(absPath)) {
        return { text: `文件不存在：${path}` };
      }
      const { cmdImport } = await import("../cmd/import.js");
      const { result, output } = await captureConsole(() =>
        cmdImport({
          path: absPath,
          toChapter: typeof flags["--to"] === "number" ? flags["--to"] as number : undefined,
        })
      );
      const lines = [
        "## 导入结果",
        `exit code: ${result}`,
        "",
        "```",
        output.trim().slice(0, 2000),
        "```",
        "",
        "> ⚠️ 数据已更新，建议重新进入 TUI 以加载最新数据。",
      ];
      return {
        text: lines.join("\n"),
        suggestReload: true,
      };
    }

    // ── 完整性校验 ──
    case "validate": {
      const { cmdValidate } = await import("../cmd/validate.js");
      const { result, output } = await captureConsole(() => cmdValidate());
      const status = result === 0 ? "✅ 通过（无严重错误）" : "❌ 存在错误";
      const lines = [
        "## 完整性校验",
        `**结果：** ${status}`,
        "",
        "```",
        output.trim(),
        "```",
      ];
      return { text: lines.join("\n") };
    }

    // ── 审核 ──
    case "review": {
      const { cmdReview } = await import("../cmd/review.js");
      const revFlags: Record<string, string | boolean> = {};
      if (flags["--auto"]) revFlags["--auto"] = true;
      const { result, output } = await captureConsole(() => cmdReview(revFlags));
      const status = result === 0 ? "✅ 无待审核项" : `⚠️ exit=${result}`;
      const lines = [
        "## 审核",
        `**结果：** ${status}`,
        "",
        "```",
        output.trim().slice(0, 2000),
        "```",
      ];
      return { text: lines.join("\n") };
    }

    // ── 防剧透审计 ──
    case "audit":
    case "audit-spoilers": {
      const { cmdAuditSpoilers } = await import("../cmd/spoilers.js");
      const { result, output } = await captureConsole(() => cmdAuditSpoilers());
      const status = result === 0 ? "✅ 无越界" : "❌ 发现越界章节";
      const lines = [
        "## 防剧透审计",
        `**结果：** ${status}`,
        "",
        "```",
        output.trim(),
        "```",
      ];
      return { text: lines.join("\n") };
    }

    // ── 数据统计 ──
    case "stats": {
      const c = repo.counts();
      const chapters = repo.countChapters();
      const dbMax = repo.maxChapterInDb() ?? 0;
      const llm = repo.llmLogSummary();
      const byPhase = repo.db
        .prepare("SELECT phase, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, SUM(retries) AS retries, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures FROM llm_logs GROUP BY phase")
        .all() as { phase: string; calls: number; input: number; output: number; retries: number; failures: number }[];

      const lines: string[] = [`## 数据统计：${cfg.book}`];

      // 结构化数据
      const structRows = [
        ["章节", `${chapters}（上限 ${cfg.maxChapter}）`],
        ["实体", `${c.entities}`],
        ["别名", `${c.aliases}`],
        ["事实", `${c.facts}`],
        ["关系", `${c.relations}`],
        ["能力", `${c.abilities}`],
        ["事件", `${c.events}`],
        ["记忆锚点", `${c.memoryAnchors}`],
        ["出场记录", `${c.appearances}`],
      ];
      // 如果有待处理项，附加
      if (c.pendingDuplicates) structRows.push(["待审核重复", `${c.pendingDuplicates} ⚠️`]);
      if (c.lowConfidenceFacts) structRows.push(["低置信度事实", `${c.lowConfidenceFacts} ⚠️`]);
      if (c.openConflicts) structRows.push(["开放冲突", `${c.openConflicts} ⚠️`]);

      lines.push("");
      lines.push("### 结构化数据");
      lines.push("| 项目 | 数量 |");
      lines.push("|------|------|");
      for (const [k, v] of structRows) lines.push(`| ${k} | ${v} |`);

      // LLM 调用
      if (llm.calls > 0) {
        lines.push("");
        lines.push("### LLM 调用");
        lines.push("| 指标 | 数值 |");
        lines.push("|------|------|");
        lines.push(`| 调用次数 | ${llm.calls} |`);
        lines.push(`| 输入 tokens | ${llm.input.toLocaleString()} |`);
        lines.push(`| 输出 tokens | ${llm.output.toLocaleString()} |`);
        lines.push(`| 重试次数 | ${llm.retries} |`);
        lines.push(`| 失败次数 | ${llm.failures} |`);
        lines.push(`| 总耗时 | ${(llm.duration / 1000).toFixed(1)}s |`);

        if (byPhase.length) {
          lines.push("");
          lines.push("#### 按阶段");
          lines.push("| 阶段 | 调用 | 输入 tokens | 输出 tokens | 重试 | 失败 |");
          lines.push("|------|------|-------------|--------------|------|------|");
          for (const p of byPhase) {
            lines.push(`| ${p.phase} | ${p.calls} | ${p.input.toLocaleString()} | ${p.output.toLocaleString()} | ${p.retries} | ${p.failures} |`);
          }
        }

        const avgIn = Math.round(llm.input / llm.calls);
        const avgOut = Math.round(llm.output / llm.calls);
        lines.push(`\n平均每次调用：**${avgIn}** in / **${avgOut}** out`);
        if (dbMax > 0) {
          const ratio = 1900 / dbMax;
          lines.push(`> 估算 1900 章全本：**${Math.round(llm.input * ratio).toLocaleString()}** in / **${Math.round(llm.output * ratio).toLocaleString()}** out`);
        }
      } else {
        lines.push("\n> 暂无 LLM 调用记录（尚未执行 build 或 ask）");
      }

      return { text: lines.join("\n") };
    }

    // ── 处理进度 ──
    case "progress": {
      const dbMax = repo.maxChapterInDb() ?? 0;
      if (dbMax === 0) return { text: "chapters 表为空，请先执行 `/import` 导入小说。" };
      const batches = repo.listBatches(); // [{range: "1-5", status: "done"|"failed"}]
      const doneChapters = new Set<number>();
      const failedChapters = new Set<number>();
      for (const b of batches) {
        const [s, e] = b.range.split("-").map(Number);
        if (isNaN(s) || isNaN(e)) continue;
        for (let c = s; c <= e; c++) {
          if (b.status === "done") doneChapters.add(c);
          else failedChapters.add(c);
        }
      }
      const total = dbMax;
      const done = doneChapters.size;
      const failed = failedChapters.size;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const barWidth = 30;
      const filled = Math.round((pct / 100) * barWidth);
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

      // 未处理区间（连续未 done 的章节）
      const unprocessedRanges: string[] = [];
      let rangeStart: number | null = null;
      for (let c = 1; c <= total; c++) {
        if (!doneChapters.has(c)) {
          if (rangeStart === null) rangeStart = c;
        } else {
          if (rangeStart !== null) {
            const end = c - 1;
            unprocessedRanges.push(rangeStart === end ? `第 ${rangeStart} 章` : `第 ${rangeStart}～${end} 章`);
            rangeStart = null;
          }
        }
      }
      if (rangeStart !== null) unprocessedRanges.push(rangeStart === total ? `第 ${total} 章` : `第 ${rangeStart}～${total} 章`);

      const lines = [
        `## 处理进度`,
        "",
        `\`${bar}\` **${pct}%**（${done}/${total} 章）`,
        "",
      ];
      if (failed > 0) lines.push(`> ⚠️ ${failed} 章失败（可用 \`/build --force\` 重跑）`);
      if (unprocessedRanges.length === 0) {
        lines.push("✅ **全部章节已处理完成！**");
      } else {
        lines.push("**未处理/待重跑：**");
        for (const r of unprocessedRanges) lines.push(`- ${r}`);
        if (unprocessedRanges.length <= 3) {
          const firstChapter = unprocessedRanges[0].replace(/[^\d～]/g, "");
          const startChapter = firstChapter.split("～")[0] || "1";
          lines.push(`\n提示：用 \`/build --from ${startChapter}\` 开始处理。`);
        }
      }
      return { text: lines.join("\n") };
    }

    // ── 未知命令 ──
    default:
      return null;
  }
}

/** 命令列表提示（用于未知命令） */
export function commandHint(): string {
  return "可用命令：`/help`、`/context`、`/chapter`、`/build`、`/import`、`/validate`、`/review`、`/audit`、`/stats`、`/progress`";
}