// story review：人工 Review 循环
//   1) 疑似重复人物 → merge / rename / reject / skip
//   2) 低置信度事实 → keep / delete
//   3) 冲突记录 → resolve / dismiss
// --auto 提供自动化模式（合并为出场更多的实体），供端到端测试使用。

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, dbPath } from "../config.js";
import { StoryRepo } from "../db/repo.js";
import { suggestDuplicatesByAlias } from "../build/resolution.js";
import { log, warn, section } from "../logger.js";

export async function cmdReview(flags: Record<string, string | boolean>): Promise<number> {
  const cfg = loadConfig();
  const repo = new StoryRepo(dbPath(), cfg.maxChapter);
  const auto = flags["--auto"] === true || flags["--auto"] === "true";
  const rl = createInterface({ input, output });

  let acted = 0;
  try {
    // ---- 1. 疑似重复 ----
    const heuristicNew = suggestDuplicatesByAlias(repo);
    if (heuristicNew) log(`别名启发式新增 ${heuristicNew} 条疑似重复`);
    const pending = repo.listPossibleDuplicates("pending");
    if (pending.length) {
      section(`疑似重复人物（${pending.length} 条）`);
      for (const d of pending) {
        const a = repo.getEntity(d.entity_a);
        const b = repo.getEntity(d.entity_b);
        if (!a || !b) {
          repo.setDuplicateStatus(d.id, "rejected", "实体已不存在");
          continue;
        }
        log(renderPair(repo, a, b, d.reason ?? ""));
        if (auto) {
          // 自动：出场更多者保留
          const keep = appearances(repo, a) >= appearances(repo, b) ? a : b;
          const drop = keep.id === a.id ? b : a;
          doMerge(repo, d.id, keep, drop);
          acted++;
          continue;
        }
        const ans = (await rl.question(`是否为同一人物？(y 合并 / n 不是 / r 改名 / s 跳过，默认 s) > `)).trim().toLowerCase();
        const decision = ans === "y" ? "merge" : ans === "n" ? "reject" : ans === "r" ? "rename" : "skip";
        if (decision === "merge") {
          const pick = (await rl.question(`保留哪个实体名？[1]${a.name} / [2]${b.name}，默认保留出场更多者 > `)).trim();
          let keep = pick === "2" ? b : pick === "1" ? a : appearances(repo, a) >= appearances(repo, b) ? a : b;
          const drop = keep.id === a.id ? b : a;
          doMerge(repo, d.id, keep, drop);
        } else if (decision === "reject") {
          repo.setDuplicateStatus(d.id, "rejected");
          repo.addReviewLog("reject", a.id, b.id, "确认非同一人物");
          log(`✘ 已拒绝（非同一人物）：${a.name} / ${b.name}`);
        } else if (decision === "rename") {
          const side = (await rl.question(`改哪个？[1]${a.name} / [2]${b.name} > `)).trim();
          const target = side === "2" ? b : a;
          const newName = (await rl.question(`新名称（输入原名可仅确认）> `)).trim();
          if (newName && newName !== target.name) {
            repo.renameEntity(target.id, newName);
            repo.addReviewLog("rename", target.id, null, `${target.name} → ${newName}`);
            log(`✔ 已改名：${target.name} → ${newName}`);
          }
          repo.setDuplicateStatus(d.id, "rejected", "renamed");
        } else {
          log(`— 跳过`);
        }
        acted++;
      }
    } else {
      log("无可疑重复人物。");
    }

    // ---- 2. 低置信度事实 ----
    const lowFacts = repo.listFacts().filter((f) => f.confidence < 0.65);
    if (lowFacts.length) {
      section(`低置信度事实（confidence < 0.65，${lowFacts.length} 条）`);
      for (const f of lowFacts) {
        const e = repo.getEntity(f.entity_id);
        log(`  [${f.confidence.toFixed(2)}] ${e?.name ?? f.entity_id} · ${f.type}: ${f.value}（第${f.chapter}章）`);
        let keep = true;
        if (!auto) {
          const ans = (await rl.question(`保留？(y 保留 / n 删除，默认 y) > `)).trim().toLowerCase();
          keep = ans !== "n";
        }
        if (!keep) {
          repo.db.prepare("DELETE FROM facts WHERE id=?").run(f.id);
          repo.addReviewLog("delete_fact", f.entity_id, null, f.value);
          log(`  ✘ 已删除`);
          acted++;
        }
      }
    }

    // ---- 3. 冲突 ----
    const conflicts = repo.listConflicts("open");
    if (conflicts.length) {
      section(`事实冲突（${conflicts.length} 条）`);
      for (const c of conflicts) {
        log(`  [${c.kind}] ${c.detail}${c.chapter_a ? `（第${c.chapter_a}章）` : ""}${c.chapter_b ? ` 与 第${c.chapter_b}章` : ""}`);
        let decision = "keep";
        if (!auto) {
          const ans = (await rl.question(`处理？(k 保留待查 / d 忽略，默认 k) > `)).trim().toLowerCase();
          decision = ans === "d" ? "dismiss" : "keep";
        }
        if (decision === "dismiss") {
          repo.setConflictStatus(c.id, "dismissed");
          repo.addReviewLog("dismiss_conflict", c.entity_id, null, c.detail);
          log(`  — 已忽略`);
          acted++;
        }
      }
    }
  } finally {
    rl.close();
  }

  section("Review 完成");
  const c = repo.counts();
  log(`剩余可疑重复   : ${c.pendingDuplicates}`);
  log(`剩余开放冲突   : ${c.openConflicts}`);
  log(`低置信度事实   : ${c.lowConfidenceFacts}`);
  if (acted === 0) log("本次无操作。");
  repo.close();
  return 0;
}

function appearances(repo: StoryRepo, e: { id: string }): number {
  return repo.firstAndLastAppearance(e.id).count;
}

function doMerge(repo: StoryRepo, dupId: number, keep: { id: string; name: string }, drop: { id: string; name: string }): void {
  repo.mergeEntities(drop.id, keep.id);
  repo.setDuplicateStatus(dupId, "merged", `merged ${drop.name} into ${keep.name}`);
  repo.addReviewLog("merge", drop.id, keep.id, `确认同一人物：${drop.name} → ${keep.name}`);
  log(`✔ 已合并：${drop.name} → ${keep.name}`);
}

function renderPair(repo: StoryRepo, a: { id: string; name: string }, b: { id: string; name: string }, reason: string): string {
  const cardA = entityBrief(repo, a.id);
  const cardB = entityBrief(repo, b.id);
  return `\nPossible duplicate（原因：${reason}）\n[1] ${cardA}\n[2] ${cardB}`;
}

function entityBrief(repo: StoryRepo, id: string): string {
  const e = repo.getEntity(id)!;
  const aliases = repo.listAliases(id).map((x) => x.alias).join("、") || "无";
  const facts = repo.listFacts(id).slice(0, 3).map((f) => `${f.value}（第${f.chapter}章）`).join("；") || "无";
  const { first, count } = repo.firstAndLastAppearance(id);
  return `${e.name} [${e.type}] 首次:第${first ?? "?"}章 出场${count}章 | 别名:${aliases} | 事实:${facts}`;
}