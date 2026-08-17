// 通用小工具：slug、token 估算、文本工具

/** 生成稳定的实体 ID：`character_闻人佑` */
export function entityId(type: string, name: string): string {
  const clean = name.replace(/[^\p{L}\p{N}]/gu, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return `${type}_${clean || "unnamed"}`;
}

/** CJK 友好的 token 估算：中文按 ~0.7 token/字，英文按词 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const rest = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ");
  const words = rest.split(/\s+/).filter(Boolean).length;
  return Math.ceil(cjk * 0.7 + words * 1.3);
}

/** 把文本切分成语料（去空白、小写、去标点） */
export function normalizeText(s: string): string {
  return (s || "").toLowerCase().replace(/[\s，。！？、；：""''（）《》【】\-—…·~!?.,;:'"()\[\]{}|\\/<>+=*&^%$#@`]/g, "");
}

/** 查询串的中文二元组 + 单词集合，用于结构化文本模糊匹配 */
export function shingles(s: string, size = 2): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  if (!t) return out;
  if (t.length <= size) out.add(t);
  for (let i = 0; i + size <= t.length; i++) out.add(t.slice(i, i + size));
  return out;
}

/** 交集大小 */
export function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/** JSON 安全序列化（给 LLM 的结构化数据） */
export function stableJson(x: unknown): string {
  return JSON.stringify(x, null, 0);
}

export function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等宽表格打印 */
export function pad(s: string | number, n: number): string {
  const str = String(s);
  const cjk = (str.match(/[\u4e00-\u9fff]/g) || []).length;
  const width = str.length + cjk;
  return str + " ".repeat(Math.max(0, n - width));
}