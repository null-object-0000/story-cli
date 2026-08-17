// 极简 .env 文件加载器（零依赖）。
// 支持：
//   - 每行 KEY=VALUE，忽略 # 注释与空行
//   - 可选 `export ` 前缀
//   - 值可带单/双引号（去除引号，保留内部空格）
//   - 无引号值时去掉行尾 ` #注释`
// 优先级：真实 process.env > .env 文件（不覆盖已存在的环境变量）

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let content = line;
    if (content.startsWith("export ")) content = content.slice("export ".length).trim();
    const eq = content.indexOf("=");
    if (eq <= 0) continue;
    const key = content.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = content.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * 从 cwd 加载 .env 到 process.env（不覆盖已存在的键）。
 * 幂等安全：重复调用无害。
 */
export function loadEnvFile(cwd = process.cwd()): void {
  const p = join(cwd, ".env");
  if (!existsSync(p)) return;
  const parsed = parseEnvFile(readFileSync(p, "utf-8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}
