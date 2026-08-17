// 端到端验证脚本（无 LLM API Key 也可运行，使用 mock provider）。
// 覆盖 import 截断、build 断点续跑、review、validate、ask 7 个用例、character、stats、audit-spoilers。

import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { buildNovelText } from "./make-fixture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 编译后本文件在 dist/scripts/ 下，项目根在其上两级
const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "src", "cli.js");
const PROJ = join(ROOT, "test", ".e2e", "proj");
const FIXTURE = join(PROJ, "我不是戏神.txt");

interface TestCase {
  name: string;
  run: () => string; // return messages (empty = pass)
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✔ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✘ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new AssertionError(msg);
}

class AssertionError extends Error {}

function exec(args: string[], cwd: string = PROJ): { code: number; stdout: string; stderr: string } {
  // 合并 stdout + stderr 以便检查
  const cmd = `"${process.execPath}" "${CLI}" ${args.map((s) => (s.includes(" ") ? `"${s}"` : s)).join(" ")}`;
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (e: any) {
    const out = e.stdout?.toString()?.trim() ?? "";
    const err = e.stderr?.toString()?.trim() ?? "";
    return { code: e.status ?? 1, stdout: out, stderr: err };
  }
}

function main(): number {
  console.log("\n=== story CLI V0.1 端到端验证 ===\n");

  // 清理 + 准备
  if (existsSync(PROJ)) rmSync(PROJ, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  writeFileSync(FIXTURE, buildNovelText(), "utf-8");
  const chapterCount = 405;

  // ---- 1. init ----
  test("init", () => {
    const r = exec(["init", "--max-chapter", "405", "--book", "我不是戏神", "--user-chapter", "405"]);
    assert(r.code === 0, `init 失败: ${r.stderr}`);
    assert(existsSync(join(PROJ, ".story", "config.json")), "config.json 未创建");
    assert(existsSync(join(PROJ, ".story", "story.db")), "story.db 未创建");
  });

  // ---- 2. import ----
  test("import", () => {
    const r = exec(["import", FIXTURE, "--to-chapter", "405"]);
    assert(r.code === 0, `import 失败: ${r.stderr}`);
    assert(r.stdout.includes("识别章节") || r.stdout.includes("导入结果"), `import 输出异常: ${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes("物理截断"), `import 应报告截断，输出: ${r.stdout.slice(0, 300)}`);
    // 精确检查 DB 内章节数
    const db = join(PROJ, ".story", "story.db");
    const d = new DatabaseSync(db);
    const cnt = (d.prepare("SELECT COUNT(*) AS n FROM chapters").get() as { n: number }).n;
    d.close();
    assert(cnt === chapterCount, `章节数应为 ${chapterCount}，实际 ${cnt}`);
  });

  // ---- 3. build ----
  test("build", () => {
    const r = exec(["build", "--provider", "mock"]);
    assert(r.code === 0, `build 失败: ${r.stderr}\n${r.stdout.slice(0, 500)}`);
    assert(r.stdout.includes("Build complete"), `build 未完成: ${r.stdout.slice(0, 200)}`);
    assert(r.stdout.includes("Characters"), `build 缺少统计: ${r.stdout.slice(0, 200)}`);
  });

  // ---- 4. review --auto ----
  test("review --auto", () => {
    const r = exec(["review", "--auto"]);
    assert(r.code === 0, `review 失败: ${r.stderr}`);
    assert(r.stdout.includes("Review 完成"), `review 未完成: ${r.stdout.slice(0, 200)}`);
  });

  // ---- 5. validate ----
  test("validate", () => {
    const r = exec(["validate"]);
    assert(r.code === 0, `validate 失败（存在严重错误）: ${r.stdout.slice(0, 500)}`);
  });

  // ---- 6. ask 用例 ----
  test("ask Case 1: 闻人佑是谁来着？", () => {
    const r = exec(["ask", "闻人佑是谁来着？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("三师兄"), `应包含"三师兄"：\n${out}`);
    assert(out.includes("板车"), `应包含"板车"：\n${out}`);
    assert(out.includes("做饭"), `应包含"做饭"：\n${out}`);
    assert(out.includes("第392章"), `应包含"第392章"：\n${out}`);
    assert(!out.includes("406"), `不应包含406章信息：\n${out}`);
  });

  test("ask Case 2: 那个给大家做饭的三师兄是谁？", () => {
    const r = exec(["ask", "那个给大家做饭的三师兄是谁？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(r.stdout.includes("闻人佑"), `应回答「闻人佑」：\n${r.stdout}`);
  });

  test("ask Case 3: 那个一直拉着戏台板车的人是谁？", () => {
    const r = exec(["ask", "那个一直拉着戏台板车的人是谁？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    assert(r.stdout.includes("闻人佑"), `应回答「闻人佑」：\n${r.stdout}`);
  });

  test("ask Case 4: 陈伶到现在有哪些技能？", () => {
    const r = exec(["ask", "陈伶到现在有哪些技能？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    // 至少应包含 5 个 expected abilities
    const expected = ["心蟒", "杀戮舞曲", "秘瞳", "无相", "审判庭", "血衣", "猩红戏法", "正义的铁拳", "通讯设备", "织命"];
    const found = expected.filter((e) => out.includes(e));
    assert(found.length >= 5, `应包含至少 5 个能力，实际匹配 ${found.length}/${expected.length}：\n${out}`);
  });

  test("ask Case 5: 心蟒是谁的能力？陈伶什么时候得到的？", () => {
    const r = exec(["ask", "心蟒是谁的能力？陈伶什么时候得到的？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("心蟒"), `应包含能力名：\n${out}`);
    assert(out.includes("白也"), `应包含来源"白也"：\n${out}`);
    assert(out.includes("第170章") || out.includes("170"), `应包含获得章节：\n${out}`);
  });

  test("ask Case 6: 陈伶和闻人佑是什么关系？", () => {
    const r = exec(["ask", "陈伶和闻人佑是什么关系？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("师兄弟") || out.includes("三师兄"), `应包含关系"师兄弟"：\n${out}`);
  });

  test("ask Case 7: 闻人佑最喜欢什么颜色？", () => {
    const r = exec(["ask", "闻人佑最喜欢什么颜色？", "--provider", "mock"]);
    assert(r.code === 0, `ask 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("不足以可靠回答"), `应回答"不足以可靠回答"：\n${out}`);
  });

  // ---- 7. character ----
  test("character 闻人佑", () => {
    const r = exec(["character", "闻人佑"]);
    assert(r.code === 0, `character 失败: ${r.stderr}`);
    const out = r.stdout;
    assert(out.includes("闻人佑"), `应包含人物名：\n${out}`);
    assert(out.includes("三师兄"), `应包含身份"三师兄"：\n${out}`);
    assert(out.includes("第392章"), `应包含章节：\n${out}`);
  });

  test("character 不存在的人", () => {
    const r = exec(["character", "张三"]);
    assert(r.code !== 0, `应返回非零：${r.stdout.slice(0, 200)}`);
  });

  // ---- 8. stats ----
  test("stats", () => {
    const r = exec(["stats"]);
    assert(r.code === 0, `stats 失败: ${r.stderr}`);
    assert(r.stdout.includes("Chapters"), `stats 应包含统计：\n${r.stdout.slice(0, 200)}`);
  });

  // ---- 9. audit-spoilers ----
  test("audit-spoilers", () => {
    const r = exec(["audit-spoilers"]);
    assert(r.code === 0, `audit-spoilers 失败或发现违规: ${r.stdout.slice(0, 500)}`);
    assert(r.stdout.includes("Spoiler violations: 0"), `应报告 0 违规：\n${r.stdout.slice(0, 300)}`);
  });

  // ---- 10. 断点续跑验证 ----
  test("build 断点续跑（应跳过已完成批次）", () => {
    const r = exec(["build", "--provider", "mock"]);
    assert(r.code === 0, `续跑 build 失败: ${r.stderr}`);
    assert(r.stdout.includes("跳过已完成的批次"), `应报告跳过：\n${r.stdout.slice(0, 300)}`);
  });

  test("build --force 区间重跑", () => {
    const r = exec(["build", "--from-chapter", "390", "--to-chapter", "405", "--force", "--provider", "mock"]);
    assert(r.code === 0, `force build 失败: ${r.stderr}`);
    // 应输出 [390-...] extracting
    assert(r.stdout.includes("390"), `应包含 390 区间：\n${r.stdout.slice(0, 300)}`);
  });

  // ---- 11. 防剧透直接 DB 检查 ----
  test("DB 防剧透硬检查", () => {
    const d = new DatabaseSync(join(PROJ, ".story", "story.db"));
    const tables = [
      { t: "entities", c: "first_seen_chapter" },
      { t: "entities", c: "last_seen_chapter" },
      { t: "aliases", c: "from_chapter" },
      { t: "facts", c: "chapter" },
      { t: "relations", c: "chapter" },
      { t: "abilities", c: "chapter" },
      { t: "abilities", c: "acquired_chapter" },
      { t: "events", c: "chapter" },
      { t: "memory_anchors", c: "chapter" },
      { t: "entity_appearances", c: "chapter" },
    ];
    let totalVio = 0;
    for (const { t, c } of tables) {
      const n = (d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} IS NOT NULL AND ${c} > 405`).get() as { n: number }).n;
      if (n > 0) {
        console.log(`    违规: ${t}.${c} = ${n}`);
        totalVio += n;
      }
    }
    d.close();
    assert(totalVio === 0, `数据库中存在 ${totalVio} 条越界章节记录！`);
  });

  // ---- 12. 静态检查：Ask/Agent/TUI 模块绝不触碰 chapters 原文表 ----
  test("Ask 模块不读取原文", () => {
    const dirs: { dir: string; files: string[]; opsOnly?: boolean }[] = [
      { dir: join(ROOT, "src", "ask"), files: ["answer.ts", "context.ts", "intent.ts", "recall.ts", "search.ts"] },
      { dir: join(ROOT, "src", "agent"), files: readdirSync(join(ROOT, "src", "agent")).filter((f) => f.endsWith(".ts")) },
      { dir: join(ROOT, "src", "tui"), files: readdirSync(join(ROOT, "src", "tui")).filter((f) => f.endsWith(".ts")) },
    ];
    for (const { dir, files } of dirs) {
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf-8");
        const isOps = f === "ops.ts" && dir.endsWith("agent");
        for (const forbidden of ["getChapterText", "replaceChapters", "FROM chapters", "select * from chapters"]) {
          if (content.includes(forbidden)) {
            throw new Error(`${dir}/${f} 疑似触碰 chapters 原文：包含「${forbidden}」`);
          }
        }
        // 不允许 import 相对路径的 novel/parser 模块（原文解析）
        if (/from\s+["']\.\.\/novel/.test(content)) {
          throw new Error(`${dir}/${f} 引用了 novel 模块（原文路径）`);
        }
        // ops.ts（构建工具）允许 import build/pipeline（构建能力），其余文件禁止
        if (!isOps && /from\s+["']\.\.\/build/.test(content)) {
          throw new Error(`${dir}/${f} 引用了 build 模块（原文路径）。仅 src/agent/ops.ts 允许。`);
        }
      }
    }
  });

  // ---- 总结 ----
  const total = passed + failed;
  console.log(`\n结果：${passed}/${total} 通过，${failed} 失败`);
  return failed > 0 ? 1 : 0;
}

process.exitCode = main();