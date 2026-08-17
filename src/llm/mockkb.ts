// Mock LLM 的知识底稿（离线验证用）。
// 该 KB 同时被：
//   1. scripts/make-fixture.ts 用于生成合成小说《我不是戏神（演示版）》——把下面的句子写进对应章节；
//   2. src/llm/mock.ts 的规则引擎——按“关键词命中”从章节文本中抽取结构化数据。
// 因此合成小说与 mock 抽取始终一致，可用于在无 API Key 时验证整条管道。

export interface MockCharacter {
  name: string;
  aliases: string[];
  firstChapter: number;
  protagonist?: boolean;
  type?: string;
}

export interface MockFactRule {
  entity: string;
  type: string;
  value: string;
  chapter: number;
  keywords: string[]; // 全部命中该章才抽取
  confidence: number;
}

export interface MockAnchorRule {
  entity: string;
  chapter: number;
  summary: string;
  keywords: string[];
  importance: number;
  memorability: number;
  protagonistRelevance: number;
}

export interface MockRelationRule {
  from: string;
  to: string;
  type: string;
  detail: string;
  chapter: number;
  keywords: string[];
  confidence: number;
}

export interface MockAbilityRule {
  entity: string;
  name: string;
  category: string | null;
  system: string | null;
  path: string | null;
  level: string | null;
  source: string | null;
  acquiredChapter: number | null;
  summary: string | null;
  keywords: string[];
  chapter: number;
}

export interface MockEventRule {
  chapter: number;
  participants: string[];
  type: string;
  summary: string;
  keywords: string[];
  importance: number;
}

export interface MockDuplicateRule {
  entityA: string;
  entityB: string;
  reason: string;
  keywords: string[];
}

export const MOCK_CHARACTERS: MockCharacter[] = [
  { name: "陈伶", aliases: ["红心6", "篡火者13号"], firstChapter: 1, protagonist: true },
  { name: "闻人佑", aliases: ["三师兄", "老三"], firstChapter: 392 },
  { name: "栾梅", aliases: ["梅花K"], firstChapter: 100 },
  { name: "梅花K", aliases: [], firstChapter: 100 }, // 与栾梅疑似重复，用于测试 review merge
  { name: "白也", aliases: [], firstChapter: 60 },
  { name: "林宴", aliases: ["记者林宴"], firstChapter: 210 },
  { name: "大师兄", aliases: ["大师兄"], firstChapter: 391, type: "character" },
];

export const MOCK_FACTS: MockFactRule[] = [
  { entity: "陈伶", type: "identity", value: "戏鬼", chapter: 1, keywords: ["陈伶", "戏鬼"], confidence: 0.99 },
  { entity: "闻人佑", type: "role", value: "戏道古藏三师兄", chapter: 392, keywords: ["闻人佑", "三师兄"], confidence: 0.99 },
  { entity: "闻人佑", type: "personality", value: "沉默寡言、不苟言笑", chapter: 394, keywords: ["闻人佑", "沉默寡言"], confidence: 0.95 },
  { entity: "闻人佑", type: "habit", value: "平时负责给戏道古藏众人做饭", chapter: 397, keywords: ["闻人佑", "做饭"], confidence: 0.97 },
  { entity: "闻人佑", type: "occupation", value: "负责教授陈伶戏曲基本功中的【念】", chapter: 400, keywords: ["闻人佑", "念"], confidence: 0.94 },
  { entity: "陈伶", type: "status", value: "戏道古藏修行弟子", chapter: 392, keywords: ["陈伶", "戏道古藏"], confidence: 0.93 },
  { entity: "栾梅", type: "identity", value: "也拥有戏鬼血统", chapter: 100, keywords: ["栾梅", "戏鬼血统"], confidence: 0.9 },
  { entity: "白也", type: "role", value: "盗神道的前辈，将【借月】传承给陈伶", chapter: 170, keywords: ["白也", "借月"], confidence: 0.95 },
];

export const MOCK_ANCHORS: MockAnchorRule[] = [
  {
    entity: "闻人佑",
    chapter: 392,
    summary: "首次正式登场，是那个一路拉着装满戏台道具板车的高大男人。",
    keywords: ["闻人佑", "板车"],
    importance: 0.75,
    memorability: 0.95,
    protagonistRelevance: 0.8,
  },
  {
    entity: "闻人佑",
    chapter: 397,
    summary: "平时负责给师门众人做饭。",
    keywords: ["闻人佑", "做饭"],
    importance: 0.5,
    memorability: 0.9,
    protagonistRelevance: 0.7,
  },
  {
    entity: "闻人佑",
    chapter: 400,
    summary: "负责教授陈伶戏曲基本功中的【念】。",
    keywords: ["闻人佑", "教"],
    importance: 0.65,
    memorability: 0.85,
    protagonistRelevance: 0.85,
  },
  {
    entity: "陈伶",
    chapter: 1,
    summary: "被选召为戏鬼，背负全城命运的『戏道』开场。",
    keywords: ["陈伶", "戏鬼"],
    importance: 0.8,
    memorability: 0.9,
    protagonistRelevance: 1,
  },
  {
    entity: "栾梅",
    chapter: 100,
    summary: "梅花K的真身，与陈伶同有戏鬼血统。",
    keywords: ["栾梅", "梅花K"],
    importance: 0.6,
    memorability: 0.85,
    protagonistRelevance: 0.8,
  },
];

export const MOCK_RELATIONS: MockRelationRule[] = [
  {
    from: "闻人佑",
    to: "陈伶",
    type: "师兄弟",
    detail: "闻人佑是陈伶的三师兄",
    chapter: 392,
    keywords: ["闻人佑", "三师兄"],
    confidence: 0.99,
  },
  {
    from: "大师兄",
    to: "陈伶",
    type: "师兄弟",
    detail: "大师兄是陈伶的大师兄",
    chapter: 391,
    keywords: ["大师兄"],
    confidence: 0.9,
  },
  {
    from: "白也",
    to: "陈伶",
    type: "传承",
    detail: "白也将盗神道【借月】传承给陈伶",
    chapter: 170,
    keywords: ["白也", "借月"],
    confidence: 0.97,
  },
];

export const MOCK_ABILITIES: MockAbilityRule[] = [
  { entity: "陈伶", name: "杀戮舞曲", category: "ability", system: "戏道", path: "杀戮", level: "1", source: null, acquiredChapter: 40, summary: "以杀戮为核心的领域型能力。", keywords: ["杀戮舞曲"], chapter: 40 },
  { entity: "陈伶", name: "秘瞳", category: "ability", system: "戏道", path: "秘", level: "2", source: null, acquiredChapter: 60, summary: "可以看破伪装的瞳术。", keywords: ["秘瞳"], chapter: 60 },
  { entity: "陈伶", name: "无相", category: "ability", system: "戏道", path: "无相", level: "3", source: null, acquiredChapter: 90, summary: "模拟他人气质的易容类能力。", keywords: ["无相"], chapter: 90 },
  { entity: "陈伶", name: "审判庭", category: "ability", system: "戏道", path: "审判", level: "4", source: null, acquiredChapter: 110, summary: "构建审判法庭意象的压制能力。", keywords: ["审判庭"], chapter: 110 },
  { entity: "陈伶", name: "血衣", category: "ability", system: "戏道", path: "血", level: "4", source: null, acquiredChapter: 130, summary: "以血为媒的强化能力。", keywords: ["血衣"], chapter: 130 },
  { entity: "陈伶", name: "猩红戏法", category: "ability", system: "戏道", path: "猩红", level: "5", source: null, acquiredChapter: 150, summary: "猩红色彩的戏法系能力。", keywords: ["猩红戏法"], chapter: 150 },
  { entity: "陈伶", name: "正义的铁拳", category: "ability", system: "戏道", path: "正义", level: "5", source: null, acquiredChapter: 180, summary: "以正义为名的实体化拳技。", keywords: ["正义的铁拳"], chapter: 180 },
  { entity: "陈伶", name: "心蟒", category: "ability", system: "盗神道", path: "借月", level: "6", source: "白也", acquiredChapter: 170, summary: "与记忆和情绪相关的高阶能力。", keywords: ["心蟒"], chapter: 170 },
  { entity: "陈伶", name: "通讯设备与电磁感应原理", category: "knowledge", system: null, path: null, level: null, source: null, acquiredChapter: 220, summary: "对现代通讯设备与电磁感应的原理性认知。", keywords: ["通讯设备", "电磁感应"], chapter: 220 },
  { entity: "陈伶", name: "织命", category: "ability", system: "戏道", path: "织", level: "7", source: null, acquiredChapter: 300, summary: "操纵命运丝线的能力。", keywords: ["织命"], chapter: 300 },
  { entity: "闻人佑", name: "念", category: "skill", system: "戏道", path: "基本功", level: null, source: null, acquiredChapter: null, summary: "戏曲基本功中的【念】，闻人佑负责传授。", keywords: ["闻人佑", "念"], chapter: 400 },
];

export const MOCK_EVENTS: MockEventRule[] = [
  {
    chapter: 210,
    participants: ["林宴", "陈伶"],
    type: "encounter",
    summary: "林宴作为记者出场，开始调查戏鬼传闻，与陈伶产生交集。",
    keywords: ["林宴"],
    importance: 0.55,
  },
  {
    chapter: 392,
    participants: ["闻人佑", "陈伶"],
    type: "first_meeting",
    summary: "陈伶抵达戏道古藏，初见一路拉板车的三师兄闻人佑。",
    keywords: ["闻人佑", "板车"],
    importance: 0.8,
  },
  {
    chapter: 397,
    participants: ["闻人佑", "陈伶"],
    type: "daily_life",
    summary: "陈伶来到闻人佑家中吃饭，闻人佑平时负责给师门众人做饭。",
    keywords: ["闻人佑", "做饭"],
    importance: 0.45,
  },
  {
    chapter: 400,
    participants: ["闻人佑", "陈伶"],
    type: "training",
    summary: "闻人佑开始教授陈伶戏曲基本功【念】。",
    keywords: ["闻人佑", "教"],
    importance: 0.6,
  },
];

export const MOCK_DUPLICATES: MockDuplicateRule[] = [
  {
    entityA: "栾梅",
    entityB: "梅花K",
    reason: "剧情中两人疑似同一人（梅花K为外号）",
    keywords: ["栾梅", "梅花K"],
  },
];

export const MOCK_PROTAGONIST = "陈伶";