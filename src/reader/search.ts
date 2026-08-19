// 结构化数据内的人物搜索：名称/别名精确匹配 + 全文片段 shingle 重叠。
// 搜索范围只包含：实体名、别名、事实（含性格/外貌/习惯）、记忆锚点、事件摘要、关系（全部来自结构化库，禁止原文）。
//
// 权重设计（Memory-first）：
//   - name 精确匹配最高（100）；alias 精确匹配同高（100，与 name 同池）；
//   - MemoryAnchor 是【人物模糊召回的一等来源】：按"每条锚点"独立打分，
//     bigram 重叠 + 中文一元字重叠（抓 paraphrase，如「拉很重的车上山」↔「拉着板车登上丑峰」），
//     分值可与 name 相当（上限 95），matchedVia 直接给出命中的那条记忆线索；
//   - personality/identity/appearance/habit 事实继续参与搜索（补充线索）；
//   - Relation / Ability / Event 作为补充低权重。
// 支持主角特殊提权（"主角"关键词命中时最高分）。
//
// 注意：不要把所有字段拼起来做等权匹配——锚点是专门为"模糊回忆"设计的数据，权重必须明显高于普通事实。

import { StoryRepo, EntityRow, FactRow, MemoryAnchorRow } from "../db/repo.js";
import { normalizeText, shingles, overlap } from "../util.js";

export interface EntityHit {
  entity: EntityRow;
  score: number;
  matchedVia: string;
  /** 命中来源优先级（越低越可信）：0=名称精确/主角 1=记忆线索 2=身份/性格事实 3=关系 4=事件 5=名称包含 */
  src?: number;
  /** 命中的查询内容二元组数量（同分次级键：命中更多实义词组者更可能正确） */
  nq?: number;
}
interface Searchable {
  entity: EntityRow;
  names: string[];
  /** 身份类事实逐条保留（逐条打分，避免多条事实拼接产生巧合匹配） */
  identityFacts: string[];
  /** 性格/外貌/习惯类事实逐条保留 */
  personalityFacts: string[];
  /** 每条锚点独立保留（含 kind/章节），用于逐条打分与精确 matchedVia */
  anchors: MemoryAnchorRow[];
  eventText: string;
  /** 每条关系独立保留（逐条打分，避免长文本累积造成巧合匹配） */
  relations: string[];
}

/** 身份类事实（"这人是谁/做什么"） */
const IDENTITY_FACT_TYPES = ["role", "identity", "occupation", "affiliation", "status"];
/** 性格/外貌/习惯类事实（"这人什么性格/长什么样/有什么习惯"）——也是模糊召回的重要线索 */
const PERSONALITY_FACT_TYPES = ["personality", "appearance", "habit", "description"];

/** 一元字重叠用的停用字：高频虚词/代词/系词/量词/泛化动词，避免"的/了/人/是/负责/做"把不相关实体顶上来 */
const UNIGRAM_STOP = new Set(
  "的了是在有和与也就都而及或被把让从到于之这那他她它们个不很大人会能去来上下中里时说想要给对我你谁什么怎么为什么因为所以然后还是才又再最一个种些东西事情负责任何从事进行开始成为相关属于涉及通过需要提供得到给予参与实现推动促进加强保证确保帮助支持管理处理操作联系沟通表达描述介绍说明解释回答寻找选择安排准备执行推进开展组织加入退出离开进入到达返回来自影响作用价值方式方法情况问题原因结果过程内容信息知识经验能力需求目标任务工作时间地点人物身份地位角色职业场所环境背景条件机会可能需要应该必须愿意希望认为觉得发现知道了解熟悉记得遗忘忽略关注重视强调突出".split("")
);

/** 二元组停用字：任一元字命中即丢弃该 bigram（如"的人/是谁/的是/什么/负责/进行"），
 *  避免常见的虚词组合在召回时产生假阳性。内容字（拉/车/饭/做/沉/默/脸/板…）不受影响。 */
const BIGRAM_STOP = new Set(
  "的了吗呢啊吧是这在有和与就也都这那他她它们我你谁什么怎么为因而或及把被让向从到于之等还再又最很太好个叫什负责任何从事进行开始成为相关属于涉及通过需要提供得到给予参与实现推动促进加强保证确保帮助支持管理处理操作联系沟通表达描述介绍说明解释回答寻找选择安排准备执行推进开展组织加入退出离开进入到达返回来自影响作用价值方式方法情况问题原因结果过程内容信息知识经验能力需求目标任务工作时间地点人物身份地位角色职业场所环境背景条件机会可能需要应该必须愿意希望认为觉得发现知道了解熟悉记得遗忘忽略关注重视强调突出".split("")
);

/** 内容二元组：两个字符都不是停用字的 bigram（用户真正可能用来回忆的实义词组，如"做饭/板车/上山"） */
function contentBigrams(s: string): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  if (!t) return out;
  if (t.length <= 2) {
    if (t.length === 1 && !UNIGRAM_STOP.has(t)) out.add(t);
    else if (!BIGRAM_STOP.has(t[0]) && !BIGRAM_STOP.has(t[1])) out.add(t);
    return out;
  }
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i];
    const b = t[i + 1];
    if (!BIGRAM_STOP.has(a) && !BIGRAM_STOP.has(b)) out.add(a + b);
  }
  return out;
}

/** 语料统计（idf）：内容二元组在多少实体里出现。用于让"做饭/板车/教念"这类稀有、高识别度的
 *  记忆线索权重明显高于"负责/戏道"这类常见词组——否则泛化的共现会把真正的人物顶下去。 */
interface CorpusStats {
  n: number; // 有可检索文本的实体数
  df2: Map<string, number>; // 内容二元组 → 出现它的实体数
}

function buildCorpusStats(items: Searchable[]): CorpusStats {
  const df2 = new Map<string, number>();
  let n = 0;
  for (const s of items) {
    const all = [
      ...s.identityFacts,
      ...s.personalityFacts,
      s.eventText,
      ...s.relations,
      ...s.anchors.map((a) => a.summary),
    ].join(" ");
    if (!all.trim()) continue;
    n++;
    for (const b of contentBigrams(all)) df2.set(b, (df2.get(b) ?? 0) + 1);
  }
  return { n, df2 };
}

/** 稀有度：实体占比越低的词，越可能正是用户回忆时的"独特线索"，权重越高 */
function rarity(df: number, n: number): number {
  if (n <= 0) return 1;
  const r = n / Math.max(1, df);
  if (r >= 16) return 2.2;
  if (r >= 5) return 1.6;
  if (r >= 2) return 1.2;
  return 1;
}

/** 一元字重叠分（扁平 8/字，上限随用途截断）：命中稀有字（做饭/板车/教念）与常见字同权。
 *  一元只做"换序 paraphrase"的补充信号，不做 idf——避免泛化字（负/责/山）被小语料 idf 错误抬升。 */
function weightedUnigramScore(query: string, text: string): number {
  const qc = new Set([...normalizeText(query)].filter((c) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c) && !UNIGRAM_STOP.has(c)));
  if (qc.size === 0) return 0;
  const tc = new Set([...normalizeText(text)].filter((c) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c)));
  let s = 0;
  for (const c of qc) if (tc.has(c)) s += 8;
  return s;
}

/** 加权内容二元组重叠分：命中稀有、高识别度的词组（做饭/板车/教念）权重高于常见词组（负责/戏道）。
 *  只对二元组做 idf（二元组是"用户拿来回忆的实义词组"，稀有度更能反映识别度；一元不做 idf 见上）。 */
function weightedBigramScore(query: string, text: string, stats: CorpusStats): number {
  const qb = contentBigrams(query);
  const tb = contentBigrams(text);
  let s = 0;
  for (const b of qb) if (tb.has(b)) s += 35 * rarity(stats.df2.get(b) ?? 0, stats.n);
  return s;
}

/**
 * 单条 MemoryAnchor 的召回分：加权内容二元组（35×稀有度）+ 扁平一元字（8/字），
 * 总分上限 95——让"记忆线索"成为与 name 相当的强召回来源，但始终略低于 name 精确匹配（100）。
 * 稀有词组（做饭/板车/教念）权重明显高于常见词组（负责/戏道），避免泛化共现把真正的人物顶掉。
 */
function anchorScore(query: string, anchor: string, stats: CorpusStats): number {
  return Math.min(95, weightedBigramScore(query, anchor, stats) + weightedUnigramScore(query, anchor));
}

/**
 * 单条关系的召回分（锚点式但更克制，逐条打分避免长文本累积的巧合匹配）：
 * - 有内容二元组重叠（o2>0）：强档，加权后上限 90——高于"名字被包含"(55)、低于"名字精确"(100)
 *   与记忆锚点(95)，足以把「三师兄,教授【念】」这类具体关系顶到前面；
 * - 仅一元字重叠：弱档（换序 paraphrase，如"拉很重的车上山"↔"拉着板车登丑峰"），上限 30，不压过名字匹配。
 */
function relationScore(query: string, relation: string, stats: CorpusStats): number {
  const big = weightedBigramScore(query, relation, stats);
  const uni = weightedUnigramScore(query, relation);
  if (big > 0) return Math.min(90, big + uni);
  if (uni >= 16) return Math.min(30, uni);
  if (uni >= 8) return 8;
  return 0;
}

/**
 * 单条身份/性格/外貌/习惯事实的召回分：同样 idf 加权（"负责做饭/高大/沉默"这类具体线索权重更高），
 * 上限 90——高于"名字被包含"(55)、接近锚点(95)。配合 tie-break（事实>关系），
 * 让"负责做饭"这类落在 Fact 而非 Anchor/Relation 的识别线索也能压过泛化的"负责"共现。
 */
function factScore(query: string, text: string, stats: CorpusStats): number {
  if (!text) return 0;
  return Math.min(90, weightedBigramScore(query, text, stats) + weightedUnigramScore(query, text));
}

export function buildSearchIndex(repo: StoryRepo): Searchable[] {
  const entities = repo.listEntities();
  const aliases = repo.listAliases();
  const aliasByEntity = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasByEntity.get(a.entity_id) ?? [];
    arr.push(a.alias);
    aliasByEntity.set(a.entity_id, arr);
  }
  const facts: FactRow[] = repo.listFacts();
  const anchors: MemoryAnchorRow[] = repo.listMemoryAnchors();
  const identityFactsByEntity = new Map<string, string[]>();
  const personalityFactsByEntity = new Map<string, string[]>();
  const appendFact = (m: Map<string, string[]>, id: string, v: string): void => {
    const arr = m.get(id) ?? [];
    arr.push(v);
    m.set(id, arr);
  };
  for (const f of facts) {
    if (IDENTITY_FACT_TYPES.includes(f.type)) appendFact(identityFactsByEntity, f.entity_id, f.value);
    else if (PERSONALITY_FACT_TYPES.includes(f.type)) appendFact(personalityFactsByEntity, f.entity_id, f.value);
  }
  const anchorByEntity = new Map<string, MemoryAnchorRow[]>();
  for (const a of anchors) {
    const arr = anchorByEntity.get(a.entity_id) ?? [];
    arr.push(a);
    anchorByEntity.set(a.entity_id, arr);
  }
  const eventTextByEntity = new Map<string, string>();
  for (const e of repo.listEvents()) {
    for (const p of JSON.parse(e.participants) as string[]) {
      eventTextByEntity.set(p, (eventTextByEntity.get(p) ?? "") + " " + e.summary);
    }
  }
  const relationListByEntity = new Map<string, string[]>();
  const appendRelation = (id: string, text: string): void => {
    const arr = relationListByEntity.get(id) ?? [];
    arr.push(text);
    relationListByEntity.set(id, arr);
  };
  for (const r of repo.listRelations()) {
    const fName = repo.getEntity(r.from_entity_id)?.name ?? r.from_entity_id;
    const tName = repo.getEntity(r.to_entity_id)?.name ?? r.to_entity_id;
    const full = [r.type, r.detail, fName, tName].filter(Boolean).join(" ");
    // 关系 detail 通常点名"被描述"的一端（如「三师兄,教授【念】」点名 闻人佑=to 端）。
    // 把完整 detail 只归给被点名的一端，另一端只保留"与谁是什么关系"——否则"教陈伶念的人是谁"这类
    // 问题里，学习者（陈伶）与被提问对象（闻人佑）会从同一条关系拿到同样分数而无法区分。
    const fMentions = relationMentions(r.detail, fName, aliasByEntity.get(r.from_entity_id) ?? []);
    const tMentions = relationMentions(r.detail, tName, aliasByEntity.get(r.to_entity_id) ?? []);
    if (fMentions !== tMentions) {
      const primaryId = fMentions ? r.from_entity_id : r.to_entity_id;
      const secondaryId = fMentions ? r.to_entity_id : r.from_entity_id;
      const secondaryName = fMentions ? tName : fName;
      appendRelation(primaryId, full);
      appendRelation(secondaryId, `${r.type} ${secondaryName}`);
    } else {
      appendRelation(r.from_entity_id, full);
      appendRelation(r.to_entity_id, full);
    }
  }
  return entities.map((entity) => ({
    entity,
    names: [entity.name, ...(aliasByEntity.get(entity.id) ?? [])],
    identityFacts: identityFactsByEntity.get(entity.id) ?? [],
    personalityFacts: personalityFactsByEntity.get(entity.id) ?? [],
    anchors: anchorByEntity.get(entity.id) ?? [],
    eventText: eventTextByEntity.get(entity.id) ?? "",
    relations: relationListByEntity.get(entity.id) ?? [],
  }));
}

/** 关系 detail 是否点名了该实体（正式名或任一别名出现在 detail 中） */
function relationMentions(detail: string | null, entityName: string, aliases: string[]): boolean {
  if (!detail) return false;
  const d = normalizeText(detail);
  const names = [entityName, ...aliases];
  return names.some((n) => n.length >= 2 && d.includes(normalizeText(n)));
}

/** 命中内容二元组数量：用于同分 tie-break 的次级键——命中的查询实义词组越多，越可能是正确候选
 *  （如"教陈伶【念】"命中 教陈/陈伶/伶念 三个词组 > 只命中 教陈/陈伶 两个的"教陈伶【打】"）。 */
function matchedBigramCount(query: string, text: string): number {
  const qb = contentBigrams(query);
  const tb = contentBigrams(text);
  let n = 0;
  for (const b of qb) if (tb.has(b)) n++;
  return n;
}

export function searchEntities(repo: StoryRepo, query: string, topK = 5): EntityHit[] {
  const q = normalizeText(query);
  if (!q) return [];
  const qShingles = shingles(query, 2);
  const index = buildSearchIndex(repo);
  const stats = buildCorpusStats(index);
  const protagonist = guessProtagonist(repo);
  const hits: EntityHit[] = [];

  // 逐实体打分。同分时按（命中内容二元组数降序，来源优先级低者）决出——记忆线索 > 身份/性格事实 > 关系 > 事件 > 名称包含。
  const setHit = (
    st: { score: number; via: string; src: number; nq: number },
    score: number,
    via: string,
    src: number,
    nq = 0
  ): void => {
    if (score > st.score || (score === st.score && (nq > st.nq || (nq === st.nq && src < st.src)))) {
      st.score = score;
      st.via = via;
      st.src = src;
      st.nq = nq;
    }
  };

  for (const s of index) {
    const st: { score: number; via: string; src: number; nq: number } = { score: 0, via: "", src: 9, nq: 0 };
    // 主角提权：当查询包含"主角"时，主角实体+60
    if (protagonist && s.entity.id === protagonist.id && /主角/.test(query)) setHit(st, 60, "主角", 0);
    for (const name of s.names) {
      const n = normalizeText(name);
      if (n === q) {
        setHit(st, 100, `名称「${name}」精确匹配`, 0);
      } else if (n.length >= 2 && (q.includes(n) || n.includes(q))) {
        setHit(st, 55, `名称「${name}」`, 5);
      } else {
        const o = overlap(qShingles, shingles(name, 2));
        if (o > 0) setHit(st, 20 + o * 8, `名称「${name}」`, 5);
      }
    }
    // MemoryAnchor：一等召回来源，逐条打分，精确报告命中的那条记忆线索
    for (const a of s.anchors) {
      const aScore = anchorScore(query, a.summary, stats);
      if (aScore > 0) setHit(st, aScore, `记忆线索「${a.summary.trim().slice(0, 32)}」`, 1, matchedBigramCount(query, a.summary));
    }
    // 身份/性格/外貌/习惯事实：逐条打分（idf 加权），报告具体命中的那条
    for (const f of s.identityFacts) {
      const fScore = factScore(query, f, stats);
      if (fScore > 0) setHit(st, fScore, `身份/事实「${f.trim().slice(0, 24)}」`, 2, matchedBigramCount(query, f));
    }
    for (const f of s.personalityFacts) {
      const fScore = factScore(query, f, stats);
      if (fScore > 0) setHit(st, fScore, `性格/外貌「${f.trim().slice(0, 24)}」`, 2, matchedBigramCount(query, f));
    }
    // 事件：补充低权重
    const eventOverlap = overlap(qShingles, shingles(s.eventText, 2));
    if (eventOverlap > 0) setHit(st, 4 + eventOverlap * 2, "事件摘要", 4);
    // 关系：逐条打分（锚点式），取最高，精确报告命中的那条关系
    for (const rel of s.relations) {
      const relScore = relationScore(query, rel, stats);
      if (relScore > 0) setHit(st, relScore, `关系「${rel.trim().slice(0, 28)}」`, 3, matchedBigramCount(query, rel));
    }
    if (st.score > 0) hits.push({ entity: s.entity, score: st.score, matchedVia: st.via, src: st.src, nq: st.nq });
  }
  // 主排序：分数降序；同分 → 命中内容二元组更多者优先；再同分 → 来源优先级低者优先
  hits.sort((a, b) => b.score - a.score || (b.nq ?? 0) - (a.nq ?? 0) || (a.src ?? 9) - (b.src ?? 9));
  return hits.slice(0, topK);
}

/** 主角估计：出现章节数最多的人物 */
export function guessProtagonist(repo: StoryRepo): EntityRow | null {
  const entities = repo.listEntities("character");
  let best: EntityRow | null = null;
  let bestN = -1;
  for (const e of entities) {
    const { count } = repo.firstAndLastAppearance(e.id);
    if (count > bestN) {
      bestN = count;
      best = e;
    }
  }
  return best;
}
