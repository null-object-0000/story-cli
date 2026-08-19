// 端到端验证（纯 Node 分支，无需 LLM / API Key）：
//   - Extraction 校验（Batch Range 等）
//   - DB 层不变式（same-name-different-type → type_conflict、entityName canonicalization）
//   - Reader/TUI 模块原文隔离静态检查
//
// 完整 init→import→build→ask→audit 流程需要真实 LLM，由实际使用验证（mock 已移除）。

import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StoryRepo } from "../src/db/repo.js";
import { validateExtractionOutput, ValidationError } from "../src/build/validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 编译后本文件在 dist/scripts/ 下，项目根在其上两级
const ROOT = join(__dirname, "..", "..");
const UNIT = join(ROOT, "test", ".e2e", "unit");

interface TestCase {
  name: string;
  run: () => void;
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
  if (!cond) throw new Error(msg);
}

function main(): number {
  console.log("\n=== story 端到端验证（纯 Node 分支，无需 LLM）===\n");

  if (existsSync(UNIT)) rmSync(UNIT, { recursive: true });
  mkdirSync(UNIT, { recursive: true });

  // ---- Extraction Batch Range Validation ----
  test("Extraction Batch Validation：本批范围外的 chapter 必须失败", () => {
    // 批 100~110 内通过
    const ok = validateExtractionOutput(
      { newEntities: [], aliases: [], facts: [{ entityName: "X", type: "role", value: "v", chapter: 105, confidence: 0.9 }], relations: [], abilities: [], events: [], memoryAnchors: [], possibleDuplicates: [], conflicts: [], batchSummary: null },
      100,
      110
    );
    assert(ok.facts.length === 1, "批内 chapter=105 应通过");
    // 即使第 120 章确实存在（availableThrough >= 120），本批 100~110 也不能接受 chapter=120
    let rejected = false;
    try {
      validateExtractionOutput(
        { newEntities: [], aliases: [], facts: [{ entityName: "X", type: "role", value: "v", chapter: 120, confidence: 0.9 }], relations: [], abilities: [], events: [], memoryAnchors: [], possibleDuplicates: [], conflicts: [], batchSummary: null },
        100,
        110
      );
    } catch (e) {
      rejected = e instanceof ValidationError;
    }
    assert(rejected, "chapter=120 对批 100~110 必须校验失败");
  });

  // ---- same-name-different-type 冲突检测 ----
  test("same-name-different-type → possible_duplicates(type_conflict)", () => {
    const unit = new StoryRepo(join(UNIT, "conflict.db"));
    unit.upsertEntity("concept", "梅花K测试体", 100);
    unit.upsertEntity("character", "梅花K测试体", 105);
    const tc = unit.listPossibleDuplicates().find((d) => (d.reason ?? "").includes("type_conflict"));
    assert(tc !== undefined, "应自动生成 type_conflict 疑似重复");
    unit.close();
  });

  // ---- entityName canonicalization 契约 ----
  test("entityName canonicalization：别名解析到 canonical name，不新建实体", () => {
    const unit = new StoryRepo(join(UNIT, "canonical.db"));
    unit.upsertEntity("character", "陈伶", 1);
    unit.addAlias("character_陈伶", "红心6", 60);
    // search_existing_entities 的解析路径：name 或 alias → canonical entity
    const resolved = unit.findEntityByName("红心6") ?? unit.findByAlias("红心6");
    assert(resolved !== null && resolved.name === "陈伶", "别名「红心6」应解析到 canonical name「陈伶」");
    // 契约要求：extraction 输出必须使用 canonical name（entityName=陈伶）
    const chenId = unit.findEntityByName("陈伶")!.id;
    unit.addFact(chenId, "role", "契约测试身份", 100, 0.9);
    assert(unit.findEntityByName("红心6") === null, "「红心6」仍是别名，不应成为独立实体名");
    assert(unit.listAliases(chenId).some((a) => a.alias === "红心6"), "别名「红心6」应挂在陈伶名下");
    unit.close();
  });

  // ---- 静态检查：Reader/TUI 模块绝不触碰 chapters 原文表 ----
  test("Reader/TUI 模块不读取原文", () => {
    const dirs: { dir: string; files: string[] }[] = [
      { dir: join(ROOT, "src", "reader"), files: readdirSync(join(ROOT, "src", "reader")).filter((f) => f.endsWith(".ts")) },
      { dir: join(ROOT, "src", "cli", "tui"), files: readdirSync(join(ROOT, "src", "cli", "tui")).filter((f) => f.endsWith(".ts")) },
    ];
    for (const { dir, files } of dirs) {
      for (const f of files) {
        const content = readFileSync(join(dir, f), "utf-8");
        for (const forbidden of ["getChapterText", "replaceChapters", "FROM chapters", "select * from chapters"]) {
          if (content.includes(forbidden)) {
            throw new Error(`${dir}/${f} 疑似触碰 chapters 原文：包含「${forbidden}」`);
          }
        }
        if (/from\s+["'](?:\.\.\/)+(build|novel)\//.test(content)) {
          throw new Error(`${dir}/${f} 引用了 build/novel 模块（原文路径）`);
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
