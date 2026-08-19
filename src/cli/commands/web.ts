// `story web` — 启动本地小说百科网站。
// 只读结构化知识（复用 StoryRepo 数据访问层 + src/web/server.ts），
// 不读 chapters 原文；阅读进度（userChapter）过滤在服务端数据访问层实现。

import { existsSync } from "node:fs";
import { projectDir, configPath } from "../../config.js";
import { startWebServer } from "../../web/server.js";

export async function cmdWeb(flags: Record<string, string | boolean>): Promise<number> {
  const cwd = process.cwd();
  const cfgFile = configPath(cwd);
  if (!existsSync(projectDir(cwd)) || !existsSync(cfgFile)) {
    throw new Error(`未找到项目配置 ${cfgFile}，请先运行：story init <小说文件>`);
  }

  const portFlag = flags["--port"];
  const port = typeof portFlag === "string" && /^\d+$/.test(portFlag) ? Number.parseInt(portFlag, 10) : 8765;
  const hostFlag = flags["--host"];
  const host = typeof hostFlag === "string" && hostFlag.length > 0 ? hostFlag : "127.0.0.1";
  const quiet = flags["--quiet"] === true;

  const handle = await startWebServer({ port, host, cwd, quiet });

  console.log("小说百科网站已启动：");
  console.log(`  ${handle.url}`);
  console.log("  阅读进度默认取 config.userChapter，可在网页顶部实时调整 —— 未读到的人物/情节不会显示（防剧透）");
  console.log("  Ctrl+C 停止");

  // 保持进程存活（服务端 keep-alive）。main() 的收尾不会执行，属预期。
  await new Promise<number>(() => {});
  return 0;
}