// Mock LLM Provider：确定性规则引擎。
// 用于：
//   1. 无 LLM_API_KEY 时验证整条 Build/Ask 管道；
//   2. 端到端测试（防剧透、断点续跑、查询等）。
// 它只“看懂” mockkb 中定义的事实句（由合成小说写入对应章节），是真实 LLM 抽取的理想化替身。

import { ExtractionInput, ExtractionResult, LlmProvider } from "./types.js";
import { estimateTokens } from "../util.js";
import {
  MOCK_ABILITIES,
  MOCK_ANCHORS,
  MOCK_CHARACTERS,
  MOCK_DUPLICATES,
  MOCK_EVENTS,
  MOCK_FACTS,
  MOCK_RELATIONS,
} from "./mockkb.js";

function mentions(text: string, keyword: string): boolean {
  return text.includes(keyword);
}

export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const { texts, startChapter, endChapter } = input;
    const all = texts.map((t) => ({ chapter: t.chapter, text: t.title + "\n" + t.text }));

    const newEntities: { name: string; type: string; firstSeenChapter: number }[] = [];
    const aliases: { entityName: string; alias: string; fromChapter: number }[] = [];
    const facts: unknown[] = [];
    const relations: unknown[] = [];
    const abilities: unknown[] = [];
    const events: unknown[] = [];
    const memoryAnchors: unknown[] = [];
    const possibleDuplicates: unknown[] = [];

    const chapterSet = new Set(all.map((a) => a.chapter));
    const inRange = (c: number) => c >= startChapter && c <= endChapter;

    // 章节内出现的人物（用于别名 / 首次登场 / 事件 / 摘要）
    const present: Record<number, Set<string>> = {};
    for (const a of all) {
      present[a.chapter] = new Set<string>();
      for (const ch of MOCK_CHARACTERS) {
        if (a.chapter < ch.firstChapter) continue;
        if (mentions(a.text, ch.name) || ch.aliases.some((al) => a.chapter >= 1 && mentions(a.text, al))) {
          present[a.chapter].add(ch.name);
        }
      }
    }

    // 首次登场的实体（仅在名字/别名真的出现在该章文本中时创建——与真实 LLM 行为一致）
    for (const ch of MOCK_CHARACTERS) {
      const firstAll = all.find((a) => a.chapter === ch.firstChapter);
      if (!firstAll) continue;
      const nameAppears = mentions(firstAll.text, ch.name) || ch.aliases.some((al) => mentions(firstAll.text, al));
      const aliasAppears = ch.aliases.some((al) => mentions(firstAll.text, al));
      if (nameAppears) {
        newEntities.push({ name: ch.name, type: ch.type ?? "character", firstSeenChapter: ch.firstChapter });
        for (const al of ch.aliases) {
          // 别名只有真实出现在文本中才登记
          if (aliasAppears || mentions(firstAll.text, al)) {
            aliases.push({ entityName: ch.name, alias: al, fromChapter: ch.firstChapter });
          }
        }
      }
    }

    // 事实
    for (const f of MOCK_FACTS) {
      for (const a of all) {
        if (a.chapter === f.chapter && f.keywords.every((k) => mentions(a.text, k))) {
          facts.push({ entityName: f.entity, type: f.type, value: f.value, chapter: f.chapter, confidence: f.confidence });
        }
      }
    }

    // MemoryAnchor
    for (const m of MOCK_ANCHORS) {
      for (const a of all) {
        if (a.chapter === m.chapter && m.keywords.every((k) => mentions(a.text, k))) {
          memoryAnchors.push({
            entityName: m.entity,
            chapter: m.chapter,
            summary: m.summary,
            importance: m.importance,
            memorability: m.memorability,
            protagonistRelevance: m.protagonistRelevance,
          });
        }
      }
    }

    // 关系
    for (const r of MOCK_RELATIONS) {
      for (const a of all) {
        if (a.chapter === r.chapter && r.keywords.every((k) => mentions(a.text, k))) {
          relations.push({ fromName: r.from, toName: r.to, type: r.type, detail: r.detail, chapter: r.chapter, confidence: r.confidence });
        }
      }
    }

    // 能力
    for (const ab of MOCK_ABILITIES) {
      for (const a of all) {
        if (a.chapter === ab.chapter && ab.keywords.every((k) => mentions(a.text, k))) {
          abilities.push({
            entityName: ab.entity,
            name: ab.name,
            category: ab.category,
            system: ab.system,
            path: ab.path,
            level: ab.level,
            sourceEntity: ab.source,
            acquiredChapter: ab.acquiredChapter,
            summary: ab.summary,
            chapter: ab.chapter,
          });
        }
      }
    }

    // 事件
    for (const e of MOCK_EVENTS) {
      if (!inRange(e.chapter) || !chapterSet.has(e.chapter)) continue;
      const a = all.find((x) => x.chapter === e.chapter);
      if (a && e.keywords.every((k) => mentions(a.text, k))) {
        events.push({ chapter: e.chapter, participantNames: e.participants, type: e.type, summary: e.summary, importance: e.importance });
      }
    }
    // 通用出场事件：只对“3 人以上同场”且章节号为 10 的倍数（约 1/10 章节）记录，避免噪音
    for (const a of all) {
      const names = [...(present[a.chapter] ?? [])].sort();
      if (names.length >= 3 && a.chapter % 10 === 0 && !events.some((e: any) => e.chapter === a.chapter)) {
        events.push({
          chapter: a.chapter,
          participantNames: names,
          type: "scene",
          summary: `本章主要人物同场：${names.join("、")}。`,
          importance: 0.3,
        });
      }
    }

    // 疑似重复
    for (const d of MOCK_DUPLICATES) {
      for (const a of all) {
        if (d.keywords.every((k) => mentions(a.text, k))) {
          possibleDuplicates.push({ entityA: d.entityA, entityB: d.entityB, reason: d.reason });
          break;
        }
      }
    }

    const batchNames = new Set<string>();
    for (const a of all) for (const n of present[a.chapter] ?? []) batchNames.add(n);

    return {
      output: {
        newEntities,
        aliases,
        facts,
        relations,
        abilities,
        events,
        memoryAnchors,
        possibleDuplicates,
        conflicts: [],
        batchSummary: `第${startChapter}-${endChapter}章：${batchNames.size ? [...batchNames].join("、") : "过渡"}等人物登场。`,
      },
      // mock 的可观测性：估算 usage（无真实缓存）
      usage: {
        inputTokens: estimateTokens(JSON.stringify(input)),
        cachedTokens: 0,
        outputTokens: estimateTokens(JSON.stringify({ newEntities, aliases, facts, relations, abilities, events, memoryAnchors })),
      },
    };
  }

  async complete(): Promise<never> {
    throw new Error("mock provider 不提供通用对话补全（Ask 请使用模板回答器或配置真实 LLM）");
  }
}