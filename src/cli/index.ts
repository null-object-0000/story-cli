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
    "--from-chapter", "--to-chapter", "--batch-size", "--retries",
    "--model", "--book", "--user-chapter", "--chapter", "--parallel", "--port", "--host",
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
      const { cmdInit } = await import("./commands/init.js");
      return cmdInit(args);
    },
    help: "story init <小说文件路径> [--book 书名] [--user-chapter N]   初始化项目并导入整本小说（初始化必须有小说内容；更换小说 = 用新文件重跑 init）",
  },
  build: {
    run: async (args) => {
      const { cmdBuild } = await import("./commands/build.js");
      return cmdBuild(args.flags, args.positional);
    },
    help: "story build [--from N] [--to N] [--force] [--batch-size N] [--auto-batch] [--keep-going] [--retries N]  抽取结构化数据（Agent 化抽取，默认构建已导入未构建的全部章节；--to N 为本次构建任务结束章节）",
  },
  review: {
    run: async (args) => {
      const { cmdReview } = await import("./commands/review.js");
      return cmdReview(args.flags);
    },
    help: "story review [--auto]   人工审核（可疑重复、低置信度事实、冲突）",
  },
  ask: {
    run: async (args) => {
      const { cmdAsk } = await import("./commands/ask.js");
      if (!args.positional.length) throw new Error("用法：story ask <问题>");
      return cmdAsk(args.positional.join(" "), args.flags);
    },
    help: "story ask <问题> [--chapter N]   基于结构化数据回答（人物卡片/无剧透问答；--chapter 临时覆盖阅读进度）",
  },
  stats: {
    run: async () => {
      const { cmdStats } = await import("./commands/stats.js");
      return cmdStats();
    },
    help: "story stats   数据与成本统计 + 构建性能 + 完整性校验（含 story validate；严重错误 → exit 1）",
  },
  audit: {
    run: async (args) => {
      const { cmdAudit } = await import("./commands/audit.js");
      return cmdAudit(args.flags);
    },
    help: "story audit [--chapter N]   Reader 可见性审计（验证 Reader API 不泄露超出 userChapter 的数据）",
  },
  tui: {
    run: async (args) => {
      const { cmdTui } = await import("./commands/tui.js");
      return cmdTui(args.flags);
    },
    help: "story tui   交互式小说问答界面（TUI，输入 / 可查看全部斜杠命令：status / settings / login / logout / chapter / build / import / review / audit / clear / exit；未初始化时会询问是否初始化；未配置 LLM 时可进入后用 /login 配置）",
  },
  web: {
    run: async (args) => {
      const { cmdWeb } = await import("./commands/web.js");
      return cmdWeb(args.flags);
    },
    help: "story web [--port N] [--host H] [--quiet]   启动本地小说百科网站（只读结构化知识；阅读进度过滤防剧透，不展示正文；Ctrl+C 停止）",
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
    "  （无；LLM 连接由环境变量或 .story/config.json 的 llm.* 决定，可在 TUI 内用 /login 配置）",
    "",
    "环境变量或项目根 .env 文件（用于真实 LLM）：",
    "  LLM_BASE_URL    OpenAI-compatible 端点",
    "  LLM_API_KEY     API Key",
    "  LLM_MODEL       模型名",
    "  （真实环境变量优先于 .env 文件）",
    "",
    "更多信息与验证用例：",
    "  story init --book 我不是戏神 <小说文件>",
    "  story build",
    "  story ask 闻人佑是谁来着？ --chapter 405",
    "  story audit --chapter 405",
    "  story web   # 本地小说百科网站（阅读进度过滤防剧透）",
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

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exitCode = 1;
});