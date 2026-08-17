// 生成合成小说《我不是戏神（演示版）》：
// 用于无 LLM API Key 时验证整条管道（import 截断 / build 抽取 / review / validate / ask / 防剧透）。
// 内容由 src/llm/mockkb.ts 的规则驱动——mock 抽取器只“认识”这些句子，二者天然一致。
//
// 注意：第 405 章之后故意写入“剧透”内容（第 406 章起使用中文数字标题），
// import 必须把它们全部丢弃——这是防剧透物理截断的直接验证。

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_ABILITIES,
  MOCK_ANCHORS,
  MOCK_CHARACTERS,
  MOCK_DUPLICATES,
  MOCK_EVENTS,
  MOCK_FACTS,
  MOCK_RELATIONS,
} from "../src/llm/mockkb.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX = 405;
const TOTAL = 420;

const CN_UNITS = ["", "十", "百", "千"];

/** 数字转中文数字（1..9999） */
function cn(n: number): string {
  if (n === 0) return "零";
  const digits = String(n).split("").map(Number);
  let out = "";
  const len = digits.length;
  let lastNonZero = false;
  for (let i = 0; i < len; i++) {
    const d = digits[i];
    const unit = CN_UNITS[len - 1 - i];
    if (d === 0) {
      if (lastNonZero && i < len - 1) out += "零";
      lastNonZero = false;
    } else {
      if (d === 1 && unit === "十" && len > 1) out += unit;
      else out += "一二三四五六七八九"[d - 1] + unit;
      lastNonZero = true;
    }
  }
  return out;
}

const SPECIAL_TITLES: Record<number, string> = {
  1: "戏鬼回家",
  40: "杀戮舞曲",
  60: "秘瞳",
  90: "无相",
  100: "梅花K",
  110: "审判庭",
  130: "血衣",
  150: "猩红戏法",
  170: "借月",
  180: "正义的铁拳",
  220: "电磁感应",
  300: "织命",
  392: "三师兄",
  397: "师门烟火",
  400: "念",
  405: "我是谁！！",
};

const TITLE_POOL = ["山雨欲来", "暗流涌动", "夜谈", "归途", "戏台之下", "面具", "旧事", "风起", "试探", "裂痕", "灯火", "远行", "回声", "伏笔", "交错"];

function titleFor(n: number): string {
  if (SPECIAL_TITLES[n]) return SPECIAL_TITLES[n];
  return TITLE_POOL[n % TITLE_POOL.length];
}

function chapterHeader(n: number): string {
  // 405 章之后用中文数字标题，验证解析器同时支持两种写法
  return n > MAX ? `第${cn(n)}章` : `第${n}章`;
}

function bodyFor(n: number): string[] {
  const out: string[] = [];

  for (const f of MOCK_FACTS) {
    if (f.chapter === n) out.push(`　　有人提起：${f.entity}，${f.value}。`);
  }
  for (const m of MOCK_ANCHORS) {
    if (m.chapter === n) out.push(`　　${m.summary}`);
  }
  for (const r of MOCK_RELATIONS) {
    if (r.chapter === n) out.push(`　　师门中人都知道，${r.detail}。`);
  }
  for (const ab of MOCK_ABILITIES) {
    if (ab.chapter === n) {
      const sys = ab.system ? `（${[ab.system, ab.path].filter(Boolean).join("·")}）` : "";
      out.push(`　　${ab.entity}获得了能力「${ab.name}」${sys}。${ab.summary ?? ""}`);
    }
  }
  for (const e of MOCK_EVENTS) {
    if (e.chapter === n) out.push(`　　${e.summary}`);
  }
  for (const d of MOCK_DUPLICATES) {
    // 第一次出现栾梅的章节给出身份线索
    if (n === 100) out.push(`　　${d.entityA}，人称${d.entityB}，是京城那家戏院的台柱。`);
  }

  // 每章固定的“在场人物”句，用于制造出场记录与同场事件
  const cast = MOCK_CHARACTERS.filter((c) => c.firstChapter <= n).slice(0, 4);
  if (cast.length) {
    out.push(`　　${cast.map((c) => c.name).join("、")}的身影在暮色中若隐若现，山寨里飘着饭菜的香气。`);
  }
  out.push(`　　陈伶放下手中的茶盏，望向远处的灯火，思绪飘回很久以前。`);

  // 正文占位
  out.push(`　　这一晚没有特别的事发生，但所有人都知道，故事还远没有结束。`);
  return out;
}

function futureBodyFor(n: number): string[] {
  const out: string[] = [];
  if (n === 406) {
    out.push(`　　（剧透禁区示例）北境的寒风里，闻人佑拉着的板车换成了战车。`);
    out.push(`　　三师兄的角色，将在三百章后彻底改变。`);
  } else if (n === 410) {
    out.push(`　　（剧透禁区示例）陈伶的织命丝线缠绕住整座城池，审判庭落下帷幕。`);
  } else {
    out.push(`　　（第${n}章内容，属于第 ${MAX + 1} 章之后，绝不允许进入任何处理流程。）`);
  }
  return out;
}

export function buildNovelText(): string {
  const lines: string[] = [];
  lines.push("我不是戏神（合成演示版，由 scripts/make-fixture.ts 生成，仅供离线验证）");
  lines.push("本书为验证 CLI 管道而生成，非真实小说文本。");
  lines.push("");
  for (let n = 1; n <= TOTAL; n++) {
    lines.push(`${chapterHeader(n)} ${titleFor(n)}`);
    lines.push("");
    if (n <= MAX) {
      lines.push(...bodyFor(n));
    } else {
      lines.push(...futureBodyFor(n));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const target = join(__dirname, "..", "..", "assets", "demo-novel.txt");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buildNovelText(), "utf-8");
  console.log(`已生成合成小说：${target}（共 ${TOTAL} 章，含 ${TOTAL - MAX} 章“剧透禁区”）`);
}

if (process.argv[1] && process.argv[1].endsWith("make-fixture.js")) {
  main();
} else if (existsSync(join(__dirname, "..", "assets"))) {
  // 被 e2e 引用时不做任何事
}