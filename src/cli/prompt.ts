// 轻量交互提示：方向键单选列表（参考 Claude Code 风格）与非 TTY 回退
//   在 TTY 下：↑/↓ 移动、Enter 确认、1..N 数字直接选、Esc/Ctrl+C 取消
//   非 TTY（管道/脚本）下自动回退为「输入序号」文本提示，避免阻塞

import { createInterface as createInterfacePromises } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configPath } from "../config.js";

export interface SelectOptions {
  /** 选项上方的说明文字（仅首次渲染显示） */
  prompt?: string;
  /** 底部提示行（如操作说明），随选择刷新 */
  footer?: string;
}

const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`;
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;

/**
 * 交互式单选列表。返回选中项索引（0-based）；取消（Esc/Ctrl+C）或
 * 非 TTY 下读到空输入/EOF 时返回 null。
 */
export async function select(options: string[], opts: SelectOptions = {}): Promise<number | null> {
  if (options.length === 0) return null;
  if (!input.isTTY || !output.isTTY) return selectFallback(options, opts);

  return new Promise<number | null>((resolve) => {
    let idx = 0;
    let first = true;
    let finished = false;
    let buffer = "";
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    // 需要反复重绘的块高：选项 + 底部提示行
    const height = options.length + (opts.footer ? 1 : 0);

    const render = () => {
      if (first) {
        if (opts.prompt) output.write(opts.prompt + "\n");
        output.write("\n"); // 提示与选项之间的空行
        first = false;
      } else {
        output.write(`\x1b[${height}A`); // 光标回到选项块首行
      }
      for (let i = 0; i < options.length; i++) {
        output.write(`\x1b[2K\r`); // 清当前行再重写
        const text = `${i + 1}. ${options[i]}`;
        output.write(i === idx ? `${cyan("❯")} ${bold(text)}\n` : `  ${text}\n`);
      }
      if (opts.footer) {
        output.write(`\x1b[2K\r${dim(opts.footer)}\n`);
      } else {
        output.write(`\x1b[2K\r`); // 占位空行，保持块高
      }
    };

    const cleanup = () => {
      if (escTimer) clearTimeout(escTimer);
      input.removeListener("data", onData);
      if (input.setRawMode) input.setRawMode(false);
      input.pause?.();
      output.write("\n");
    };

    const finish = (result: number | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const handleKey = (action: "up" | "down" | "enter" | "cancel" | "digit", ch?: string) => {
      if (finished) return;
      switch (action) {
        case "up":
          idx = idx === 0 ? options.length - 1 : idx - 1;
          render();
          break;
        case "down":
          idx = idx === options.length - 1 ? 0 : idx + 1;
          render();
          break;
        case "enter":
          finish(idx);
          break;
        case "cancel":
          finish(null);
          break;
        case "digit": {
          const n = Number(ch);
          if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            idx = n - 1;
            render();
          }
          break;
        }
      }
    };

    // 处理累积的按键字节流（转义序列可能拆包到达，需缓冲）
    const processBuffer = () => {
      if (buffer.startsWith("\u001b") && buffer.length === 1) {
        // 孤立的 ESC：可能是拆包的转义序列，稍等片刻再判断
        if (!escTimer) {
          escTimer = setTimeout(() => {
            escTimer = null;
            buffer = "";
            handleKey("cancel");
          }, 40);
        }
        return;
      }
      if (buffer.startsWith("\u001b[")) {
        const code = buffer[2];
        buffer = buffer.slice(3);
        if (code === "A") handleKey("up");
        else if (code === "B") handleKey("down");
        // 其余（左右键、未知序列）忽略
      } else if (buffer.startsWith("\u001bO")) {
        const code = buffer[2];
        buffer = buffer.slice(3);
        if (code === "A") handleKey("up");
        else if (code === "B") handleKey("down");
      } else {
        const ch = buffer[0];
        buffer = buffer.slice(1);
        if (ch === "\r" || ch === "\n") handleKey("enter");
        else if (ch === "\u0003") handleKey("cancel");
        else if (/^[1-9]$/.test(ch)) handleKey("digit", ch);
        // 其余按键忽略
      }
      if (buffer.length) processBuffer();
    };

    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      processBuffer();
    };

    // 进入 raw 模式：终端不做行编辑/回显，直接收原始字节
    if (input.setRawMode) input.setRawMode(true);
    input.setEncoding?.("utf8");
    input.resume?.();
    input.on("data", onData);

    render();
  });
}

/** 非 TTY 回退：逐行读取序号（供管道/脚本/无 raw 模式环境） */
async function selectFallback(options: string[], opts: SelectOptions = {}): Promise<number | null> {
  const rl = createInterfacePromises({ input, output });
  try {
    if (opts.prompt) output.write(opts.prompt + "\n");
    options.forEach((o, i) => output.write(`  ${i + 1}. ${o}\n`));
    for (;;) {
      const ans = (await rl.question(`选择 [1-${options.length}]，直接回车取消 > `)).trim();
      if (!ans) return null;
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      output.write(`  无效输入，请输入 1-${options.length}\n`);
    }
  } finally {
    rl.close();
  }
}

/**
 * 项目未初始化时询问是否初始化（story tui 等交互命令使用）。
 * 返回 true 表示同意初始化，false 表示退出。
 */
export async function confirmInit(cwd = process.cwd()): Promise<boolean> {
  const choice = await select(
    ["初始化项目并继续（story init）", "退出"],
    {
      prompt: `未找到项目配置 ${configPath(cwd)}。是否初始化当前目录？`,
      footer: "↑/↓ 选择 · Enter 确认 · Esc 取消",
    }
  );
  return choice === 0;
}
