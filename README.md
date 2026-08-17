# story — 长篇小说结构化知识 + 无剧透问答 CLI（V0.1）

> 阅读长篇小说时，突然再次出现一个人物，读者只觉得名字眼熟，却已经忘记这个人是谁、之前什么时候出现过、跟主角发生过什么。
>
> **story** 把小说提前结构化成 Story Data，让系统在问答阶段**完全不读原文**的情况下，5 秒帮读者恢复剧情记忆，而且**绝不剧透**。

V0.1 是一个快速验证版本：只服务一个人物，`我不是戏神`（第 1～405 章），只做一件事——验证「结构化 Story Data 是否足以支撑一个很好用的阅读记忆助手」。

---

## 1. 快速开始（无需任何 API Key）

仓库自带两个演示组件，开箱即用：

- `assets/demo-novel.txt` — 合成的演示小说（420 章，其中 406～420 章是故意写入的“剧透禁区”，用于验证物理截断）；
- `.story/` — 已经用 mock 抽取器构建好的演示数据库（1～405 章）。

```bash
# 编译（Node >= 22.5，零运行时依赖）
npm install
npm run build

# 直接用自带的 story.cmd（Windows）或 story（bash）运行
story.cmd ask "闻人佑是谁呀，我忘了"
story.cmd ask "那个给大家做饭的三师兄是谁？"
story.cmd ask "那个一直拉着戏台板车的人是谁？"
story.cmd ask "陈伶到现在有哪些技能？"
story.cmd ask "心蟒是谁的能力？陈伶什么时候得到的？"
story.cmd ask "陈伶和闻人佑是什么关系？"
story.cmd ask "闻人佑最喜欢什么颜色？"   # 结构数据不足 → 明确回答“不足以可靠回答”
story.cmd character 闻人佑
story.cmd stats
story.cmd audit-spoilers
```

端到端自动化验证（20 项）：

```bash
npm run e2e
```

---

## 2. 接入真实小说与真实 LLM

### 2.1 准备环境变量

LLM 层基于 **[@earendil-works/pi-ai](https://github.com/earendil-works/pi)**（统一多提供商 LLM API，支持 30+ 提供商：DeepSeek、Qwen、OpenAI、Anthropic、Google，以及任意 OpenAI-compatible 端点）。当前通过以下环境变量配置自定义 OpenAI-compatible 服务：

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible 端点，例如 `http://127.0.0.1:18640/v1`、`https://api.deepseek.com/v1`、`https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `LLM_API_KEY` | API Key |
| `LLM_MODEL` | 模型名，例如 `flowlet-pro`、`deepseek-chat`、`qwen-plus` |

三个变量也可以写在**项目根目录的 `.env` 文件**里（每行 `KEY=VALUE`，支持 `#` 注释与引号）。真实环境变量优先于 `.env`：

```bash
# .env
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-chat
```

> 未来可直接换用 pi-ai 的官方提供商工厂（如 DeepSeek/Qwen），只需改一行 provider 注册代码，`LlmProvider` 抽象层无需变动。

### 2.2 完整工作流（真实小说）

```bash
story init --max-chapter 405 --book "我不是戏神"
story import "./我不是戏神.txt" --to-chapter 405
story build          # 分批次（默认每 5 章一批，405 章 = 81 次 LLM 调用）抽取
story review         # 人工确认疑似重复人物 / 低置信度事实 / 冲突
story validate       # 完整性校验
story ask "闻人佑是谁来着？"
story stats
story audit-spoilers
```

要点：

- **import 物理截断**：解析章节时第 406 章及以后**直接丢弃**，不进 DB、不进任何后续流程。
- **断点续跑**：`story build` 中断后重跑，自动跳过已完成的批次；`story build --from-chapter 150 --to-chapter 180 --force` 可重抽问题区间。
- **成本统计**：每次 LLM 调用记录 model / tokens / duration / 成功失败，`story stats` 输出汇总并估算整本（≈1900 章）成本。

---

## 3. 架构：两个严格隔离的阶段

```
Build 阶段                           Ask 阶段
小说原文                               用户问题
  ↓                                     ↓
LLM 可以阅读原文                      检索 story.db（只读结构化表）
  ↓                                     ↓
抽取结构化数据 → story.db              组装 STRUCTURED STORY DATA（JSON）
                                        ↓
                                      LLM（只看结构化 JSON）
                                        ↓
                                      自然语言答案
```

| | Build Agent | Ask Agent |
|---|---|---|
| 小说原文 | ✅ 可以读取 | ❌ 禁止读取（代码路径上不存在） |
| chapters 原始文本 | ✅ 可以读取 | ❌ 禁止 |
| RAG 原文 / 搜索全文 | —— | ❌ 禁止 |
| 结构化数据库 | ✅ 写入 | ✅ 只读检索 |

防剧透是**物理层面**的，不依赖 prompt：

1. **SQLite CHECK 约束**：所有带章节号的表内置 `CHECK(chapter <= maxChapter)`，越界记录根本无法入库；
2. **import 截断**：第 406 章及以后在解析阶段直接丢弃；
3. **Ask 代码路径**：ask 模块只调用 `StoryRepo` 的结构化表查询方法，不存在读取 `chapters` 表的代码（e2e 中有静态检查）；
4. **audit-spoilers**：逐表审计越界记录，只要 > 0 就 `exit code != 0`。

---

## 4. 数据模型（V0.1）

所有知识都带 `chapter`，状态变化不覆盖旧值（`第100章身份=普通弟子`、`第300章身份=某组织成员` 两条并存，支持“第200章时他是谁”类查询）。

| 表 | 含义 | 示例 |
|---|---|---|
| `entities` | 故事实体（character/organization/location/item/concept） | `character_闻人佑`，首次登场 392 章 |
| `aliases` | 别名/外号/师门称呼/代号 | `三师兄 → 闻人佑`，`老三 → 闻人佑` |
| `facts` | 人物事实（role/identity/personality/affiliation/status/occupation/appearance/ability/habit/description/other） | `role=戏道古藏三师兄` @392，confidence 0.99 |
| `relations` | 人物关系（必须带章节） | 闻人佑—陈伶 `师兄弟` @392 |
| `abilities` | 能力（system/path/level/source/acquiredChapter 允许为空，不假设所有小说有境界） | `心蟒`：盗神道·借月，第 170 章获得，来源白也 |
| `events` | 重要事件（只记对记忆/关系/身份/能力有帮助的） | `第397章 陈伶来闻人佑家吃饭` |
| `memory_anchors` | **记忆锚点**：为什么读者可能记得这个人（短、具体、有画面感） | `392章 首次正式登场，是那个一路拉着装满戏台道具板车的高大男人` |
| `entity_appearances` | 人物出场章节（含最近出现时间） | 闻人佑 392～405 共 14 章 |
| `possible_duplicates` | 疑似重复实体（人工确认） | 栾梅 / 梅花K |
| `batch_state` | 批次状态（断点续跑） | `1-5 done` |
| `llm_logs` | 每次调用的成本日志 | model/tokens/duration |

抽取输出必须通过 runtime 校验（结构、章节范围、confidence 范围），不合格自动重试，重试仍失败则该批跳过并记录错误——**绝不把脏数据入库**。

---

## 5. 命令一览

```text
story init [--max-chapter N] [--book 书名]     创建项目（.story/config.json + story.db）
story import <文件> [--to-chapter N]            导入并物理截断到第 N 章
story build [--from N] [--to N] [--force] [--batch-size N] [--provider openai|mock] [--retries N]
story review [--auto]                           人工审核：合并/改名/拒绝疑似重复、低置信度事实、冲突
story validate                                  完整性校验（越界章节 = 严重错误，exit 1）
story ask <问题> [--provider openai|mock]       仅基于结构化数据回答
story tui [--provider openai|mock]              交互式小说问答界面（TUI）
story character <人物名>                        人物卡片
story stats                                     数据量与 LLM 成本统计
story audit-spoilers                            防剧透审计（越界 > 0 时 exit 1）
```

`--provider` 默认：检测到 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 用 `openai`，否则用 `mock`（离线模板回答器，仅用于验证管道）。

---

## 6. Ask 的行为约束

Ask Agent 的 system prompt 明确要求（并在代码层兜底）：

- 只能根据 `STRUCTURED STORY DATA` 回答；
- 不能使用模型自身关于这本书的知识，不能推测数据中不存在的章节号/能力/事实；
- 数据不足时必须回答：**当前结构化数据不足以可靠回答这个问题。**（例如“闻人佑最喜欢什么颜色？”）；
- 回答优先给：这人是谁 → 为什么你可能记得他（有画面感的锚点）→ 与主角的重要交集 → 最近一次出现。

`story ask` 的 Intent 识别支持：`RECALL_CHARACTER / LIST_ABILITIES / ABILITY_LOOKUP / CHARACTER_RELATION / CHARACTER_HISTORY / LAST_APPEARANCE / ENTITY_SEARCH / GENERAL_STRUCTURED_QA`。模糊找人（“那个做饭的三师兄是谁？”）走 **别名 + 记忆锚点 + 事实文本** 的结构化检索，全程不碰原文。

---

## 6b. Agent 驱动模式（V0.2 方向）

LLM 模式下，`story ask` 与 `story tui` 基于 [@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) 的 Agent 循环，由模型自己决定检索调度（不再硬编码 intent → search → context 管道）：

- **工具集**（全部只读结构化数据）：`search_entities`（模糊找人）、`get_entity`（完整档案）、`list_abilities`（能力）、`get_relations`（关系）、`list_events`（事件）、`get_entity_index`（全书实体索引）、`get_progress`（阅读进度）、`list_chapters`（章节目录元信息）、`set_chapter_focus`（**选定章节焦点**，后续检索只返回该区间数据）。
- **`story tui`**：基于 [@earendil-works/pi-tui](https://github.com/earendil-works/pi) 的交互式界面——底部输入框提问、上方 Markdown 渲染回答、实时显示工具调用过程、支持多轮连续追问（Agent 保持会话状态）。
  - 支持**斜杠命令**（像 Claude Code 一样）：`/help` 查看所有命令，`/context` 查看工作区上下文，`/build` 执行构建，`/import` 导入小说，`/validate` 校验，`/review` 审核，`/audit` 防剧透审计，`/stats` 查看统计，`/clear` 清屏，`/exit` 退出。
- 防剧透约束不变：所有工具只经 `StoryRepo` 读结构化表，`chapters` 原文在 Ask/Agent/TUI 代码路径上不存在（e2e 静态检查已扩展覆盖 `src/agent`、`src/tui`）。
- 未配置 LLM 时（mock 模式）继续走内置模板回答器，`story ask` 行为与 V0.1 完全一致。

---

## 7. 验证结果（2025 年，mock 离线构建，1～405 章）

```
Chapters: 405  |  Characters: 6 |  Facts: 8  |  Relations: 3
Abilities: 11  |  Events: 33    |  Memory Anchors: 5 |  Appearances: 1059
LLM calls: 81  |  in ≈ 33k tokens |  out ≈ 4.2k tokens |  failures: 0
Spoiler violations: 0     validate: 无严重错误
```

7 个验收问题全部通过（含“心蟒来源白也/第170章”的能力查询、以及故意问不存在的“颜色”必须回答数据不足）。`npm run e2e` 共 20 项断言全部通过。

> ⚠️ mock 是理想化抽取器的替身，只“认识”合成小说里的句子。真实小说请配置 LLM 后重新 `story import + story build --force`，抽取质量以真实模型的输出为准。

---

## 8. 目录结构

```text
src/
  cli.ts                命令行入口
  config.ts             .story/config.json
  novel/parser.ts       章节解析（阿拉伯/中文数字标题，物理截断）
  db/schema.ts          SQLite schema（CHECK chapter <= maxChapter）
  db/repo.ts            数据访问层（Ask 只经此处读结构化表）
  llm/                  provider 抽象：pi-ai 适配器（OpenAI-compatible，流式/JSON 模式/token 统计）+ mock
  build/                prompts、抽取输出校验、Build pipeline（分批量/续跑/重试）、实体消歧
  ask/                  intent、实体搜索、Recall Card 排序、结构化上下文、模板回答器
  agent/                小说领域 Agent：工具集（NovelTool）、系统提示词、Agent 组装（pi-agent-core）
  tui/                  pi-tui 交互式问答界面 + 斜杠命令处理器
  cmd/                  各子命令
scripts/
  make-fixture.ts       生成合成演示小说
  e2e.ts                端到端自动化验证（20 项断言）
```

## 9. 已知边界（V0.1 有意不做）

不做：Web UI、阅读器、Neo4j、云同步、账号、多本书/多租户。实体消歧部分是人工确认（`story review`）。Embedding 检索未引入（结构化检索用词元重叠即可），Ask 阶段 LLM 依赖 `LLM_API_KEY`（无 key 时退化为模板回答器）。当真实问题答不好时，请优先检查是 Entity/Alias/Fact/Relation/Ability/MemoryAnchor/消歧哪一环缺失，再改进抽取，而不是给 Ask 加原文。