// Ask 阶段 Intent 识别（V0.1 使用启发式关键词 + 少量规则；不读取原文）

export type Intent =
  | "RECALL_CHARACTER"
  | "LIST_ABILITIES"
  | "ABILITY_LOOKUP"
  | "CHARACTER_RELATION"
  | "CHARACTER_HISTORY"
  | "LAST_APPEARANCE"
  | "ENTITY_SEARCH"
  | "GENERAL_STRUCTURED_QA";

const RE = {
  abilities: /技能|能力|会什么|会些|招式|学了什么|学了哪些|能力是|有哪些.*(技能|能力)/,
  abilityLookup: /谁的能力|谁的本事|什么时候.*(获得|得到|学会|习得)|哪里来的/,
  relation: /关系|和.*什么关系|与.*什么关系|怎么称呼|什么称呼/,
  lastAppearance: /上次|最后一次|最近.*出现|多久没|什么时候出现|在哪一章|第几章|多少章没/,
  history: /经历|发生过|故事|历史|之前发生|以前|回忆/,
  entitySearch: /是谁|叫什么|叫啥|名字|名是|哪个|哪位|谁是|那个人|做饭的|拉.*板车|找.*人/,
  recallCharacter: /忘了|记不得|记不清|眼熟|是想不起来|是谁来着|是谁呀|是谁啊|想不起|不记得/,
};

export function classifyIntent(question: string): Intent {
  if (RE.recallCharacter.test(question)) return "RECALL_CHARACTER";
  if (RE.abilities.test(question)) return "LIST_ABILITIES";
  if (RE.abilityLookup.test(question)) {
    // “心蟒是谁的能力？” 这类问题由 ability 命中后在 ask 层升级为 ABILITY_LOOKUP
    return "ENTITY_SEARCH";
  }
  if (RE.relation.test(question)) return "CHARACTER_RELATION";
  if (RE.lastAppearance.test(question)) return "LAST_APPEARANCE";
  if (RE.history.test(question)) return "CHARACTER_HISTORY";
  if (RE.entitySearch.test(question)) return "ENTITY_SEARCH";
  return "GENERAL_STRUCTURED_QA";
}

export const INTENT_NAMES: Record<Intent, string> = {
  RECALL_CHARACTER: "回忆人物",
  LIST_ABILITIES: "列出能力",
  ABILITY_LOOKUP: "查询能力",
  CHARACTER_RELATION: "人物关系",
  CHARACTER_HISTORY: "人物经历",
  LAST_APPEARANCE: "最近出现",
  ENTITY_SEARCH: "模糊找人",
  GENERAL_STRUCTURED_QA: "通用结构化问答",
};