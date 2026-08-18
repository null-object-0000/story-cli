// TUI 斜杠命令处理器：/build, /import, /status, /review, /audit, /help
// 像 Claude Code 一样，在输入框输入 /xxx 执行运维操作，结果渲染到聊天区
// 命令注册表 SLASH_COMMANDS 同时驱动 pi-tui Editor 的斜杠命令自动补全

import { StoryRepo } from "../../db/repo.js";
import { StoryConfig, saveConfig } from "../../config.js";
import { LlmProvider } from "../../llm/types.js";
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
  { name: "status", description: "工作区状态：数据量/成本/构建性能/进度/完整性校验" },
  { name: "config", description: "查看/修改配置（分组：llm / build / reader）", argumentHint: "[组] 或 [key=value]" },
  { name: "chapter", description: "查看/切换当前阅读进度（Ask 防剧透边界）", argumentHint: "<章节号>" },
  { name: "build", description: "构建知识库（Agent 化抽取，失败即停）", argumentHint: "[--from N] [--to N] [--force] [--batch-size N] [--auto-batch] [--no-agent] [--keep-going]" },
  { name: "import", description: "导入小说文件（会清空现有数据）", argumentHint: "<文件路径>" },
  { name: "review", description: "审核疑似重复/低置信度数据", argumentHint: "[--auto]" },
  { name: "audit", description: "防剧透审计" },
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
          "| `/status` | 工作区状态：数据量 / LLM 成本 / 构建性能 / 处理进度 / 完整性校验（合并了原 /context /stats /progress /validate） |",
          "| `/config` | 查看/修改配置（分组：`/config llm`、`/config build`、`/config reader`；设置如 `/config llm.model=deepseek-v4-flash`） |",
          "| `/chapter <N>` | 切换当前阅读进度（Ask 防剧透边界，默认第 1 章） |",
          "| `/build [--from N] [--to N] [--force] [--batch-size N] [--auto-batch] [--no-agent] [--keep-going]` | 构建知识库（Agent 化抽取：模型自己检索已有实体；--no-agent 回退注入式，--keep-going 失败后继续） |",
          "| `/import <path>` | 导入小说文件（注意：会清空现有数据） |",
          "| `/review [--auto]` | 审核疑似重复/低置信度数据 |",
          "| `/audit` | 防剧透审计 |",
          "| `/clear` | 清空聊天历史 |",
          "| `/exit` | 退出 |",
          "",
          "普通文本直接进入 Agent 问答模式。",
        ].join("\n"),
      };

    // ── 工作区状态（合并原 /context /stats /progress /validate） ──
    case "status": {
      const chapters = repo.countChapters();
      const availableThrough = repo.availableThrough() ?? 0;
      const builtThrough = repo.builtThrough();
      const focus = (ctx as any).focus ?? null;
      const focusLine = focus?.from != null
        ? `章节焦点：第 ${focus.from} ～ ${focus.to} 章`
        : "章节焦点：无（检索全部章节）";
      // 最近 5 章（在 userChapter 范围内）
      const recentChapters = repo.listChapterMeta().slice(-5);
      const recentLine = recentChapters.length
        ? `最近 5 章：${recentChapters.map((m) => `第 ${m.chapter} 章 ${m.title}`).join("、")}`
        : "最近 5 章：无";

      const lines = [`## 工作区状态：${cfg.book}`, ""];

      // ── 上下文 ──
      lines.push("### 上下文");
      lines.push(`- 已导入章节：${chapters}（availableThrough = ${availableThrough}）`);
      lines.push(`- 已构建章节：${builtThrough ?? 0}（builtThrough）`);
      lines.push(`- 当前阅读进度：**第 ${cfg.userChapter} 章**（/chapter 切换）`);
      lines.push(`- ${focusLine}`);
      lines.push(`- ${recentLine}`);
      lines.push(`- **LLM ${provider ? "已配置" : "未配置"}**${provider ? "" : "（可用 `/config llm` 配置，保存后重启 TUI 生效）"}`);

      // ── 处理进度 ──
      lines.push("");
      lines.push("### 处理进度");
      const batches = repo.listBatches(); // [{range: "1-5", status: "done"|"failed"}]
      const doneChapters = new Set<number>();
      const failedChapters = new Set<number>();
      for (const b of batches) {
        const [s, e] = b.range.split("-").map(Number);
        if (isNaN(s) || isNaN(e)) continue;
        for (let ch = s; ch <= e; ch++) {
          if (b.status === "done") doneChapters.add(ch);
          else failedChapters.add(ch);
        }
      }
      // 失败统计不包含已被 done 批次覆盖的章节（如旧失败批与后来逐章成功批重叠）
      for (const ch of [...failedChapters]) if (doneChapters.has(ch)) failedChapters.delete(ch);
      const done = doneChapters.size;
      const failed = failedChapters.size;
      const pct = availableThrough > 0 ? Math.round((done / availableThrough) * 100) : 0;
      const barWidth = 30;
      const filled = Math.round((pct / 100) * barWidth);
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
      lines.push(`\`${bar}\` **${pct}%**（${done}/${availableThrough} 章）`);
      if (failed > 0) lines.push(`> ⚠️ ${failed} 章失败（可用 \`/build\` 自动重试）`);
      // 未处理区间（连续未 done 的章节）
      const unprocessedRanges: string[] = [];
      let rangeStart: number | null = null;
      for (let ch = 1; ch <= availableThrough; ch++) {
        if (!doneChapters.has(ch)) {
          if (rangeStart === null) rangeStart = ch;
        } else {
          if (rangeStart !== null) {
            unprocessedRanges.push(rangeStart === ch - 1 ? `第 ${rangeStart} 章` : `第 ${rangeStart}～${ch - 1} 章`);
            rangeStart = null;
          }
        }
      }
      if (rangeStart !== null) unprocessedRanges.push(rangeStart === availableThrough ? `第 ${availableThrough} 章` : `第 ${rangeStart}～${availableThrough} 章`);
      if (unprocessedRanges.length === 0) {
        lines.push("✅ **全部章节已处理完成！**");
      } else {
        lines.push("**未处理/待重跑：**");
        for (const r of unprocessedRanges) lines.push(`- ${r}`);
      }

      // ── 数据 & 成本 & 性能 & 完整性（复用 cmdStats，含退出码） ──
      lines.push("");
      lines.push("### 数据 & 成本 & 性能 & 完整性");
      const { cmdStats } = await import("../commands/stats.js");
      const { result, output } = await captureConsole(() => cmdStats());
      lines.push("```");
      lines.push(output.trim());
      lines.push("```");
      lines.push(result === 0 ? "✅ 完整性通过（无严重错误）" : "❌ 完整性存在严重错误");
      return { text: lines.join("\n") };
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
      // 上限 = 已导入章节数（availableThrough），不是配置
      const max = repo.availableThrough() ?? 0;
      if (max > 0 && n > max) {
        return { text: `章节号 ${n} 超过已导入的最大章节 ${max}（可用 story import 导入更多章节）。` };
      }
      // 更新 config
      cfg.userChapter = n;
      const { saveConfig } = await import("../../config.js");
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
      return { text: `✅ 阅读进度已切换为 **第 ${n} 章**（对话已重置，之前的上下文已清除）。\n\n之后所有检索只返回 ≤ 第 ${n} 章的数据。\n> 当前工作区过滤边界：${repo.userChapter} 章（${n < max ? `收窄，仅 ${n} 章前数据可见` : '全量数据可见'}）\n> 注意：这不会影响已构建的结构化数据，只是 Ask 检索的过滤边界。`, suggestClear: true };
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
      const { runBuild } = await import("../../build/pipeline.js");

      // 进度回调：每批开始/完成时更新 TUI（使用 ctx.onProgress 流式渲染）
      const batchResults: { range: string; status: string; }[] = [];
      const onProgress = ctx.onProgress
        ? (p: import("../../build/pipeline.js").BuildProgress) => {
            // 记录批次状态（range 为空表示"无待处理"的初始化事件，跳过）
            if (p.range) {
              const idx = batchResults.findIndex((b) => b.range === p.range);
              if (idx >= 0) batchResults[idx] = { range: p.range, status: p.status };
              else batchResults.push({ range: p.range, status: p.status });
            }

            const pct = p.totalChapters > 0 ? Math.round((p.doneChapters / p.totalChapters) * 100) : 0;
            const barWidth = 20;
            const filled = Math.round((pct / 100) * barWidth);
            const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

            // ETA：基于历史真实的抽取速率（字符/秒）推算剩余章节
            let eta = "";
            try {
              const bm = repo.buildMetrics("extract");
              if (bm.calls > 0 && bm.durationMs > 0 && bm.chapters > 0 && p.totalChapters > p.doneChapters) {
                const charsPerSec = (bm.chars / bm.durationMs) * 1000;
                const avgCharsPerChapter = bm.chars / bm.chapters;
                const remaining = p.totalChapters - p.doneChapters;
                const etaSec = (remaining * avgCharsPerChapter) / charsPerSec;
                if (etaSec > 0) eta = `（预计剩余 ${formatDuration(etaSec)}）`;
              }
            } catch { /* 指标不可用时静默 */ }

            const lines = [`## 🔨 构建中`, ``];
            if (p.totalChapters === 0) {
              lines.push("无待处理章节（全部已完成？可用 `--force` 强制重跑）");
            } else {
              lines.push(`\`${bar}\` **${pct}%**（${p.doneChapters}/${p.totalChapters} 章）${eta}`);
            }
            if (p.failedCount > 0) lines.push(`> ⚠️ ${p.failedCount} 批失败`);
            lines.push("");
            // 正在处理（LLM 调用中）
            if (p.running.length > 0) {
              lines.push(`**正在处理：** ${p.running.map((r) => `[${fmtRange(r)}]`).join(" ")} ⏳`);
              // 当前批次运行日志（agent 活动：调用工具 / 生成 JSON 等），避免干等
              if (p.statusLine) {
                lines.push(`> ${p.statusLine}`);
              }
              lines.push("");
            }
            // 已完成/失败批次（最近 10 条）
            const settled = batchResults.filter((b) => b.status !== "running" && b.status !== "pending").slice(-10);
            if (settled.length > 0) {
              for (const b of settled) {
                const icon = b.status === "done" ? "✅" : "❌";
                lines.push(`- ${icon} ${fmtRange(b.range)}`);
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
          batchSize: typeof flags["--batch-size"] === "number"
            ? flags["--batch-size"] as number
            : (cfg.build?.batchSize ?? undefined),
          concurrency: 1,
          autoBatch: flags["--auto-batch"] === true || (flags["--batch-size"] !== undefined ? false : (cfg.build?.autoBatch ?? false)),
          failFast: !(flags["--keep-going"] === true),
          agentExtract: (cfg.build?.agentExtract ?? true) === true && flags["--no-agent"] !== true,
          sessionLog: cfg.build?.sessionLog ?? true,
          maxBatchChapters: cfg.build?.maxBatchChapters,
          perChapterOutputTokens: cfg.build?.perChapterOutputTokens,
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
        for (const b of failed) summary.push(`- ${b.range} ❌${b.error ? `（${b.error}）` : ""}`);
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
      const { cmdImport } = await import("../commands/import.js");
      const { result, output } = await captureConsole(() =>
        cmdImport({
          path: absPath,
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

    // ── 审核 ──
    case "review": {
      const { cmdReview } = await import("../commands/review.js");
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
    case "audit": {
      const { cmdAudit } = await import("../commands/audit.js");
      const { result, output } = await captureConsole(() => cmdAudit());
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

    // ── 配置（分组查看 + 修改，类似 code agent 的 /config） ──
    case "config": {
      const arg = positional[0] ?? "";
      const usage = "用法：`/config`（全部）/ `/config <组>`（llm|build|reader）/ `/config <key>=<value>`（设置，如 `/config llm.model=deepseek-v4-flash`）";

      // 1) 查看某组
      if (arg) {
        const grp = CONFIG_GROUPS.find((g) => g.group === arg);
        if (grp) {
          return { text: ["## 配置：", ...renderConfigGroup(cfg, grp)].join("\n") };
        }
      }

      // 2) 设置 key=value
      const eq = arg.indexOf("=");
      if (eq > 0) {
        const key = arg.slice(0, eq).trim();
        const raw = arg.slice(eq + 1);
        const entry = findConfigKey(key);
        if (!entry) {
          return { text: `❌ 未知配置项：\`${key}\`。可用项：\n\n${renderConfigKeys(cfg)}` };
        }
        try {
          const val = coerceConfigValue(key, entry.type, raw);
          setConfigValue(cfg, key, val);
          saveConfig(cfg);
          // 阅读进度改动即时同步（repo 边界 + 工具上下文 + 清 Agent 历史防泄露）
          if (key === "userChapter") {
            repo.setUserChapter(val as number);
            if (ctx.toolCtx) ctx.toolCtx.userChapter = val as number;
            if (ctx.focus && ctx.focus.to !== null && ctx.focus.to > (val as number)) {
              ctx.focus.from = null;
              ctx.focus.to = null;
            }
            if (ctx.agent) ctx.agent.reset();
          }
          const needRestart = key.startsWith("llm.") || key.startsWith("build.");
          const masked = key === "llm.apiKey" ? "••••••（已保存）" : String(val);
          return {
            text: `✅ 已保存 \`${key}\` = \`${masked}\`\n${needRestart ? "> ⚠️ LLM / 构建配置需重启 TUI 生效（退出后重新 `npm run dev`）。" : ""}`,
          };
        } catch (e) {
          return { text: `❌ ${e instanceof Error ? e.message : String(e)}\n\n${usage}` };
        }
      }

      // 3) 无参数 → 全部
      return { text: ["## 当前配置", "", ...CONFIG_GROUPS.flatMap((g) => renderConfigGroup(cfg, g)), "", usage].join("\n") };
    }

    // ── 未知命令 ──
    default:
      return null;
  }
}

/** 命令列表提示（用于未知命令） */
export function commandHint(): string {
  return "可用命令：`/help`、`/status`、`/config`、`/chapter`、`/build`、`/import`、`/review`、`/audit`、`/clear`、`/exit`";
}

// ── 配置分组（/config） ──────────────────────────────

interface ConfigKey {
  key: string;
  type: "string" | "number" | "boolean";
  label: string;
  hint?: string;
}

interface ConfigGroup {
  group: string;
  title: string;
  keys: ConfigKey[];
}

const CONFIG_GROUPS: ConfigGroup[] = [
  {
    group: "llm",
    title: "LLM（Agent 问答 / 构建）",
    keys: [
      { key: "llm.baseUrl", type: "string", label: "OpenAI-compatible 端点", hint: "如 http://127.0.0.1:18640/v1 或 https://api.deepseek.com/v1" },
      { key: "llm.apiKey", type: "string", label: "API Key" },
      { key: "llm.model", type: "string", label: "模型名", hint: "如 deepseek-chat / flowlet-pro / glm-4.5-air" },
      { key: "llm.thinkingFormat", type: "string", label: "推理协议", hint: "auto|deepseek|zai|qwen|openrouter|openai" },
      { key: "llm.extractReasoning", type: "string", label: "抽取思考强度", hint: "off|low|medium|high" },
      { key: "llm.priceInputPerM", type: "number", label: "输入单价（元/百万 token）" },
      { key: "llm.priceOutputPerM", type: "number", label: "输出单价（元/百万 token）" },
      { key: "llm.priceCachedPerM", type: "number", label: "缓存单价（元/百万 token）" },
    ],
  },
  {
    group: "build",
    title: "构建（story build）",
    keys: [
      { key: "build.batchSize", type: "number", label: "每批章节数（固定模式）" },
      { key: "build.retries", type: "number", label: "批内重试次数" },
      { key: "build.autoBatch", type: "boolean", label: "自适应分批（按上下文合并）" },
      { key: "build.perChapterOutputTokens", type: "number", label: "每章输出 token 估算" },
      { key: "build.maxBatchChapters", type: "number", label: "单批章节数上限" },
      { key: "build.agentExtract", type: "boolean", label: "Agent 化抽取" },
      { key: "build.sessionLog", type: "boolean", label: "会话日志" },
    ],
  },
  {
    group: "reader",
    title: "阅读 / 读者",
    keys: [
      { key: "userChapter", type: "number", label: "阅读进度（防剧透边界）", hint: "也可用 /chapter N 即时切换" },
      { key: "book", type: "string", label: "书名" },
    ],
  },
];

const ALL_CONFIG_KEYS: (ConfigKey & { group: string })[] = CONFIG_GROUPS.flatMap((g) => g.keys.map((k) => ({ ...k, group: g.group })));

function findConfigKey(key: string): (ConfigKey & { group: string }) | undefined {
  return ALL_CONFIG_KEYS.find((k) => k.key === key);
}

/** 按点路径读取配置值（如 cfg.llm.model） */
function getConfigValue(cfg: StoryConfig, key: string): unknown {
  return key.split(".").reduce((o: unknown, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), cfg as unknown);
}

/** 按点路径写入配置值（自动创建中间对象） */
function setConfigValue(cfg: StoryConfig, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let o = cfg as unknown as Record<string, unknown>;
  for (const p of parts) {
    if (o[p] == null || typeof o[p] !== "object") o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  o[last] = value;
}

function coerceConfigValue(key: string, type: ConfigKey["type"], raw: string): string | number | boolean {
  const v = raw.trim();
  if (type === "number") {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`「${key}」需要数值，收到：${raw}`);
    return n;
  }
  if (type === "boolean") {
    if (v === "true") return true;
    if (v === "false") return false;
    throw new Error(`「${key}」需要 true|false，收到：${raw}`);
  }
  return v;
}

function renderConfigGroup(cfg: StoryConfig, g: ConfigGroup): string[] {
  const lines = [`### ${g.group} — ${g.title}`, ""];
  for (const k of g.keys) {
    const v = getConfigValue(cfg, k.key);
    const shown = k.key === "llm.apiKey"
      ? (v ? `••••••${String(v).slice(-4)}` : "（未设置）")
      : (v === undefined || v === null ? "（未设置）" : String(v));
    lines.push(`- \`${k.key}\` = \`${shown}\` — ${k.label}${k.hint ? `（${k.hint}）` : ""}`);
  }
  lines.push("", `设置示例：\`/config ${g.keys[0].key}=...\``);
  return lines;
}

function renderConfigKeys(cfg: StoryConfig): string {
  return CONFIG_GROUPS.map((g) => `**${g.group}（${g.title}）**\n` + g.keys.map((k) => `- \`${k.key}\``).join("\n")).join("\n\n");
}

/** 批次区间格式化："38-38" → "第 38 章"；"1-26" → "第 1~26 章" */
function fmtRange(range: string): string {
  const [a, b] = range.split("-").map(Number);
  if (Number.isInteger(a) && Number.isInteger(b)) {
    return a === b ? `第 ${a} 章` : `第 ${a}~${b} 章`;
  }
  return range;
}

/** 时长格式化：秒 → "2.3 小时" / "45 分钟" / "30 秒" */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小时`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.round(seconds)} 秒`;
}