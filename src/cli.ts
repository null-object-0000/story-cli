#!/usr/bin/env node
// story CLI 入口：解析子命令 + 标志位 + 分发

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Command = (args: { positional: string[]; flags: Record<string, string | boolean> }) => Promise<number> | number;

interface CommandEntry {
  run: Command;
  help: string;
}

// 先解析命令行参数（极简 arg parser）
function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const command = argv[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const expectVal = new Set<string>([
    "--max-chapter", "--to-chapter", "--from-chapter", "--batch-size", "--retries",
    "--provider", "--model", "--book", "--user-chapter", "--parallel",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(0, eq)] = a.slice(eq + 1);
      } else if (expectVal.has(a) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        i++;
        flags[a] = argv[i];
      } else {
        flags[a] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

const commands: Record<string, CommandEntry> = {
  init: {
    run: async (args) => {
      const { cmdInit } = await import("./cmd/init.js");
      return cmdInit(args);
    },
    help: "story init [--max-chapter N] [--book 书名]     创建项目",
  },
  import: {
    run: async (args) => {
      const { cmdImport } = await import("./cmd/import.js");
      if (!args.positional.length) throw new Error("用法：story import <小说文件路径> [--to-chapter N]");
      return cmdImport({ path: args.positional[0], toChapter: parseNum(args.flags["--to-chapter"]), book: args.flags["--book"] as string | undefined });
    },
    help: "story import <文件路径> [--to-chapter N]          导入小说（截断到第 N 章）",
  },
  build: {
    run: async (args) => {
      const { cmdBuild } = await import("./cmd/build.js");
      return cmdBuild(args.flags, args.positional);
    },
    help: "story build [--from N] [--to N] [--force] [--batch-size N] [--auto-batch] [--no-agent] [--keep-going] [--provider openai|mock] [--retries N]  抽取结构化数据（Agent 化抽取，失败即停）",
  },
  review: {
    run: async (args) => {
      const { cmdReview } = await import("./cmd/review.js");
      return cmdReview(args.flags);
    },
    help: "story review [--auto]   人工审核（可疑重复、低置信度事实、冲突）",
  },
  validate: {
    run: async () => {
      const { cmdValidate } = await import("./cmd/validate.js");
      return cmdValidate();
    },
    help: "story validate   检查数据库完整性",
  },
  ask: {
    run: async (args) => {
      const { cmdAsk } = await import("./cmd/ask.js");
      if (!args.positional.length) throw new Error("用法：story ask <问题>");
      return cmdAsk(args.positional.join(" "), args.flags);
    },
    help: "story ask <问题> [--provider openai|mock]   基于结构化数据回答问题",
  },
  character: {
    run: async (args) => {
      const { cmdCharacter } = await import("./cmd/character.js");
      const name = args.positional.join(" ");
      if (!name) throw new Error("用法：story character <人物名>");
      return cmdCharacter(name);
    },
    help: "story character <人物名>   查看人物卡片",
  },
  stats: {
    run: async () => {
      const { cmdStats } = await import("./cmd/stats.js");
      return cmdStats();
    },
    help: "story stats   数据与成本统计",
  },
  "audit-spoilers": {
    run: async () => {
      const { cmdAuditSpoilers } = await import("./cmd/spoilers.js");
      return cmdAuditSpoilers();
    },
    help: "story audit-spoilers   防剧透审计（检查是否包含超限章节数据）",
  },
  audit: {
    run: async () => {
      const { cmdAuditSpoilers } = await import("./cmd/spoilers.js");
      return cmdAuditSpoilers();
    },
    help: "story audit   audit-spoilers 的别名",
  },
  tui: {
    run: async (args) => {
      const { cmdTui } = await import("./cmd/tui.js");
      return cmdTui(args.flags);
    },
    help: "story tui [--provider openai|mock]   交互式小说问答界面（TUI，支持 / 斜杠命令：/build /import /validate /review /audit /stats /context /help；未初始化时会询问是否初始化）",
  },
};

function helpText(): string {
  const lines = [
    "story CLI — 长篇小说结构化知识 + 无剧透问答助手（V0.1）",
    "",
    "命令：",
    ...Object.values(commands).map((c) => `  ${c.help}`),
    "",
    "全局 flag：",
    "  --provider openai|mock    LLM 提供商（默认：有 LLM 环境变量时 openai，否则 mock）",
    "",
    "环境变量或项目根 .env 文件（用于真实 LLM）：",
    "  LLM_BASE_URL    OpenAI-compatible 端点",
    "  LLM_API_KEY     API Key",
    "  LLM_MODEL       模型名",
    "  （真实环境变量优先于 .env 文件）",
    "",
    "更多信息与验证用例：",
    "  story init --max-chapter 405 --book 我不是戏神",
    "  story import <小说文件> --to-chapter 405",
    "  story build",
    "  story ask 闻人佑是谁来着？",
    "  story audit-spoilers",
  ];
  return lines.join("\n");
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags["--help"] || flags["-h"] || command === "help") {
    console.log(helpText());
    return 0;
  }

  const entry = commands[command];
  if (!entry) {
    console.error(`未知命令：${command}\n`);
    console.error(helpText());
    return 1;
  }

  try {
    return await entry.run({ positional, flags });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[error] ${msg}`);
    return 1;
  }
}

function parseNum(v: string | boolean | undefined): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exitCode = 1;
});