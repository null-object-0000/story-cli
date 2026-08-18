// 小说章节解析器
// 识别 "第1章 xxx" / "第 405 章：xxx" / "第0008章" / "第四百零五章 xxx" 等标题。
// 导入整本文件识别到的所有章节（不再物理截断——防剧透边界由 userChapter 在 Reader 层控制）。

export interface ParsedChapter {
  number: number;
  title: string;
  text: string; // 章节正文（不含标题行）
}

const ARABIC_RE = /^\s*第\s*(\d{1,6})\s*章\s*[:：\-—.、\s]*(.*)$/u;
const CN_RE = /^\s*第\s*([零〇一二三四五六七八九十百千两]+)\s*章\s*[:：\-—.、\s]*(.*)$/u;

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → 阿拉伯数字（支持到 9999，够用） */
export function chineseNumeralToNumber(s: string): number | null {
  if (!s) return null;
  const input = s.trim();
  // 0 的情况
  if (/^[零〇]+$/.test(input)) return 0;
  let total = 0;
  let section = 0; // 当前小节（万以下按 千/百/十 处理）
  let digit = 0;
  const chars = input.split("");
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "零") {
      continue;
    } else if (c in CN_DIGITS) {
      digit = CN_DIGITS[c];
    } else if (c === "十") {
      section += (digit === 0 ? 1 : digit) * 10;
      digit = 0;
    } else if (c === "百") {
      section += (digit === 0 ? 1 : digit) * 100;
      digit = 0;
    } else if (c === "千") {
      section += (digit === 0 ? 1 : digit) * 1000;
      digit = 0;
    } else if (c === "万") {
      total += (section === 0 && digit === 0 ? 1 : section + digit) * 10000;
      section = 0;
      digit = 0;
    } else {
      return null; // 非法字符
    }
  }
  total += section + digit;
  return total;
}

export function detectChapterNumber(line: string): number | null {
  let m = ARABIC_RE.exec(line);
  if (m) return parseInt(m[1], 10);
  m = CN_RE.exec(line);
  if (m) return chineseNumeralToNumber(m[1]);
  return null;
}

export function detectChapterTitle(line: string): string | null {
  let m = ARABIC_RE.exec(line);
  if (m) return m[2].trim();
  m = CN_RE.exec(line);
  if (m) return m[2].trim();
  return null;
}

export interface ParseResult {
  chapters: ParsedChapter[];
  preambleLines: number;
  duplicates: number;
}

/**
 * 解析整本小说文本，识别到的所有章节全部保留（1..N 连续导入）。
 * 不按任何上限截断：可用章节数由导入结果自动决定（availableThrough）。
 */
export function parseNovel(fullText: string): ParseResult {
  const lines = fullText.split(/\r?\n/);
  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter | null = null;
  let preambleLines = 0;
  let duplicates = 0;
  const seen = new Set<number>();

  const flush = () => {
    if (current) chapters.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\uFEFF/g, "");
    const num = detectChapterNumber(line);
    if (num !== null && num >= 1) {
      if (seen.has(num)) duplicates++;
      seen.add(num);
      flush();
      current = { number: num, title: detectChapterTitle(line) ?? "", text: "" };
    } else {
      if (!current) {
        if (line.trim()) preambleLines++;
        continue; // 正文开始前的杂项
      }
      current.text += (current.text ? "\n" : "") + line;
    }
  }
  flush();

  // 排序并去重（保留首次出现的版本）
  chapters.sort((a, b) => a.number - b.number);
  const byNum = new Map<number, ParsedChapter>();
  for (const c of chapters) if (!byNum.has(c.number)) byNum.set(c.number, c);
  const out = [...byNum.values()].sort((a, b) => a.number - b.number);

  return { chapters: out, preambleLines, duplicates };
}

/** 解码文本：优先 UTF-8 严格解码，失败回退 GBK，再失败回退 latin1 */
export function decodeNovel(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gbk").decode(buffer);
    } catch {
      return buffer.toString("latin1");
    }
  }
}