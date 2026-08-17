// 实体消歧（Build 阶段启发式 + 人工确认后的合并操作）
// V0.1 目标不是完全自动消歧：自动发现 → possible_duplicates → story review 人工确认。
// 另外在入库时对“别名碰撞”直接捕获。

import { StoryRepo } from "../db/repo.js";

/**
 * 别名碰撞检测：新别名如果已挂在其他实体上 → 记录 possible_duplicates。
 * 在 repo.addAlias 返回 "clash" 时调用。
 */
export function aliasClashToDuplicate(
  repo: StoryRepo,
  alias: string,
  ownerId: string,
  clashedEntityId: string
): void {
  const a = repo.getEntity(ownerId);
  const b = repo.getEntity(clashedEntityId);
  if (!a || !b) return;
  const [low, high] = [a.id, b.id].sort();
  repo.addPossibleDuplicate(low, high, `别名冲突：${alias} 同时关联「${a.name}」与「${b.name}」`);
}

/**
 * 启发式：同一人物常见“原名 + 别名”分别建了实体 → 自动建议合并候选。
 * 规则：如果 A 的别名表中出现了 B 的实体名（或反之），建议 duplicate。
 */
export function suggestDuplicatesByAlias(repo: StoryRepo): number {
  const aliases = repo.listAliases();
  const byAlias = new Map<string, string>();
  for (const a of aliases) byAlias.set(a.alias, a.entity_id);
  let suggested = 0;
  for (const entity of repo.listEntities()) {
    const hit = byAlias.get(entity.name);
    if (hit && hit !== entity.id) {
      const [low, high] = [hit, entity.id].sort();
      if (repo.addPossibleDuplicate(low, high, `别名「${entity.name}」指向另一实体（疑似重复）`)) suggested++;
    }
  }
  return suggested;
}