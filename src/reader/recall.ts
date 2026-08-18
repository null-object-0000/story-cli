// Recall Card 排序：选出最有助于恢复记忆的 3~5 条锚点。
// userChapter 是用户当前阅读进度，用于计算最近性（recency）。
// 如果 userChapter 为 0（未设置），最近性因子归零。

import { MemoryAnchorRow } from "../db/repo.js";

export function recallScore(a: Pick<MemoryAnchorRow, "importance" | "memorability" | "protagonist_relevance" | "chapter">, userChapter: number): number {
  const recency = userChapter > 0 ? a.chapter / userChapter : 0;
  return (
    0.35 * a.importance +
    0.35 * a.memorability +
    0.15 * a.protagonist_relevance +
    0.15 * recency
  );
}

export function topAnchors(anchors: MemoryAnchorRow[], userChapter: number, n = 5): MemoryAnchorRow[] {
  return [...anchors]
    .map((a) => ({ a, s: recallScore(a, userChapter) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.a);
}