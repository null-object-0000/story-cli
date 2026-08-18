# story — 长篇小说结构化知识 + 无剧透问答 CLI（V0.1）

> 阅读长篇小说时，突然再次出现一个人物，读者只觉得名字眼熟，却已经忘记这个人是谁、之前什么时候出现过、跟主角发生过什么。
>
> **story** 把小说提前结构化成 Story Data，让系统在问答阶段**完全不读原文**的情况下，5 秒帮读者恢复剧情记忆，而且**绝不剧透**。

V0.1 是一个快速验证版本。核心模型：

> **一本小说完整结构化一次，所有读者共享同一份 Story Data；每个读者只维护自己的阅读进度 `userChapter`。**

真正的无剧透边界是 `userChapter`，而不是“物理上只导入部分章节”。完整 Story DB 本来就包含整本书（包括第 406 章以后），Reader 只能看到 `chapter <= userChapter` 的结构化数据。

---

## 1. 快速开始（无需任何 API Key）

仓库自带演示组件，开箱即用：

- `assets/demo-novel.txt` — 合成的演示小说（420 章，其中第 406~420 章是故意写入的“未来内容”：未来人物 / 能力 / 身份 / 别名 / MemoryAnchor / 事件）；
- 端到端测试验证两件事同时成立：
  - **Fact A**：完整 DB 中确实存在第 406~420 章的数据（77+ 条结构化记录 + 15 章正文）；
  - **Fact B**：`userChapter = 405` 的 Reader 通过任何公开 API 都看不到这些未来数据。

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
story.cmd audit --chapter 405           # Reader 可见性审计
```

端到端自动化验证（36 项断言）：

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
story init --book "我不是戏神"
story import "./我不是戏神.txt"    # 导入整本识别到的所有章节（availableThrough 自动决定）
story build                        # 默认构建“已导入但尚未构建”的全部章节
story review                       # 人工确认疑似重复人物 / 低置信度事实 / 冲突
story validate                     # 完整性校验
story tui                          # 交互式界面；用 /chapter 405 设置自己的阅读进度
story ask "闻人佑是谁来着？" --chapter 405
story audit --chapter 405          # Reader 可见性审计
```

要点：

- **import 不再物理截断**：`story import novel.txt` 导入整本文件识别到的所有章节。例：识别 1291 章 → `availableThrough = 1291`。
- **`--to-chapter` 只存在于 `story build`**：它是【本次构建任务的结束章节】（`story build --from 300 --to 400`），与 Reader 防剧透完全无关。
- **userChapter 是 Reader 唯一的无剧透边界**：Ask / TUI / character 只返回 `chapter <= userChapter` 的结构化数据。默认 `userChapter = 1`（保守），用户用 `/chapter 405` 或 `story ask --chapter 405` 设置自己的进度。
- **断点续跑 / 成本统计 / 会话日志**均保留：`story build` 中断后重跑自动跳过已完成批次；每批完整 prompt/回复/工具轨迹落在 `.story/logs/build/`。

---

## 3. 架构：Build 与 Ask 两个严格隔离的阶段

```
                     完整小说
                        │
                        ▼
                   Build Agent（LLM 可读原文）
                        │
                        ▼
                Complete Story DB（1 ~ availableThrough 全量结构化）
                        │
              ┌─────────┼─────────┐
              │         │         │
           用户A      用户B      用户C
         userChapter userChapter userChapter
            405        863        1200
              │         │         │
              ▼         ▼         ▼
          userChapter Visibility（Reader 数据访问层过滤）
```

Ask 阶段：

```text
用户问题
  ↓
Reader Agent（禁止读取小说正文 / 禁止原文 RAG / 禁止使用模型自身的小说知识）
  ↓
结构化 Tools（只读）
  ↓
StoryRepo(userChapter=N)   ← 防剧透的第一道可靠边界（数据访问层）
  ↓
Story DB（完整）
  ↓
自然语言答案
```

| | Build Agent | Reader Agent |
|---|---|---|
| 小说原文 | ✅ 可以读取 | ❌ 禁止读取（代码路径上不存在） |
| chapters 原始文本 | ✅ 可以读取 | ❌ 禁止 |
| RAG 原文 / 搜索全文 | —— | ❌ 禁止 |
| 结构化数据库 | ✅ 写入（Build 模式，可见全部） | ✅ 只读检索（受 userChapter 过滤） |

防剧透是**数据访问层**的可靠边界，不依赖 Prompt 自觉：

1. `StoryRepo` 默认 Build 模式可见全部数据（`userChapterBound = null`）；Reader 路径调用 `setUserChapter()` 收窄。
2. 收窄后，**所有**读方法（`listEntities` / `findEntityByName` / `findByAlias` / `getEntity` / `listFacts` / `listRelations` / `listAbilities` / `listEvents` / `listMemoryAnchors` / `listAppearances` / `listChapterMeta`）只返回 `chapter / first_seen_chapter / from_chapter <= userChapter` 的数据。
3. **未来人物的“存在本身”也是剧透**：`first_seen_chapter > userChapter` 的实体，通过任何 Reader 查询（含 `findEntityByName` / `findByAlias` / `getEntity` / `search_entities` / `get_entity_index`）都表现为“不存在”。
4. **`alias.from_chapter` 参与可见性**：未来才出现的外号/身份（如第 600 章的新称呼）在 `userChapter = 405` 时解析不到。
5. **Build 与 Reader 职责隔离**：Build 处理 1 ~ availableThrough，绝不受 userChapter 限制。
6. `story audit --chapter N`（Reader 可见性审计）验证 Reader API 是否可能返回超出 N 的数据。

---

## 4. 三个关键概念

| 概念 | 含义 | 来源 |
|---|---|---|
| `availableThrough` | 小说已导入到哪里 | `MAX(chapters.chapter)`（Book Data 属性，非用户配置） |
| `builtThrough` | 结构化知识已构建到哪里 | `batch_state` 中 done 批次的最高结束章节（自动推导，不需配置） |
| `userChapter` | 用户当前读到哪里 | 用户配置（Reader 唯一的无剧透可见性边界） |

三者关系示例：

```text
availableThrough = 1291   （整本已导入）
builtThrough     =  340   （结构化只构建到 340）
userChapter      =  405   （读者已读到 405）

effectiveThrough = min(405, 340) = 340
```

如果问题依赖 341~405 章的信息，系统会如实表现“当前阅读进度为 405 章，但结构化知识目前只构建到 340 章”——**绝不假装数据完整**。

---

## 5. 数据模型（V0.1）

所有知识都带 `chapter`（含义是**读者在第几章得知这条知识 / 被结构化确认**，即 Reveal Chapter）。状态变化不覆盖旧值（`第100章身份=普通弟子`、`第500章身份=首领` 两条并存，支持“第 200 章时他是谁”类查询）。

Schema **不再把最大章节号编译进 SQLite**：带章节号的表只有 `CHECK(chapter >= 1)`，合法章节由 `chapters` 表存在性 + 抽取期 Batch Range Validation 保证。因此“章节最大值变化”永远不会成为重建 DB 的理由。

| 表 | 含义 | 示例 |
|---|---|---|
| `chapters` | 章节原文（仅 Build 使用） | 1 ~ availableThrough |
| `entities` | 故事实体（character/organization/location/item/concept） | `character_闻人佑`，首次登场 392 章 |
| `aliases` | 别名/外号/师门称呼/代号（带 `from_chapter`，参与 Reader 可见性） | `三师兄 → 闻人佑`，`未来外号 → 闻人佑` @418 |
| `facts` | 人物事实（role/identity/personality/affiliation/status/occupation/appearance/ability/habit/description/other） | `role=戏道古藏三师兄` @392，confidence 0.99 |
| `relations` | 人物关系（必须带章节） | 闻人佑—陈伶 `师兄弟` @392 |
| `abilities` | 能力（system/path/level/source/acquiredChapter 允许为空） | `心蟒`：盗神道·借月，第 170 章获得，来源白也 |
| `events` | 重要事件 | `第397章 陈伶来闻人佑家吃饭` |
| `memory_anchors` | **记忆锚点**：为什么读者可能记得这个人（短、具体、有画面感） | `392章 首次正式登场，是那个一路拉着装满戏台道具板车的高大男人` |
| `entity_appearances` | 人物出场章节 | 闻人佑 392~405 共 14 章（userChapter 边界内） |
| `possible_duplicates` | 疑似重复实体（人工确认；含 `type_conflict` 同名不同类型） | 栾梅 / 梅花K |
| `conflicts` | 事实冲突 | `open / resolved / dismissed` |
| `batch_state` | 批次状态（断点续跑 + builtThrough 推导） | `1-5 done` |
| `llm_logs` | 每次调用的成本日志 | model/tokens/duration/chars/chapters |

抽取输出必须通过 runtime 校验（结构、**当前 Batch 范围**、confidence 范围），不合格自动重试，重试仍失败则该批跳过并记录错误——**绝不把脏数据入库**。

### 5.1 抽取 Batch Range Validation

Extraction Agent 只阅读 `startChapter ~ endChapter`（例如 291~300），因此本批新抽取数据只允许产生该范围内的 Facts / Relations / Abilities / Events / MemoryAnchors / Aliases / 首次登场。即使第 800 章确实存在，只要它不属于本批范围，就属于幻觉/数据错误并被拒绝。能力的 `acquiredChapter`（故事内获得时间）允许引用本批之前的过去（如“此能力是 100 章获得的”），但不能超出本批末章。

### 5.2 实体引用契约（entityName canonicalization）

`search_existing_entities` 返回命中实体的 `id / name / type / aliases`，其中 `name` 是 canonical name（正式名）。Prompt 明确要求：

> 命中已有实体后，最终 JSON 必须使用工具返回的 canonical name 作为 `entityName / fromName / toName`，不要使用当前文本中的别名再次创建实体。

例如文本出现「红心6」，工具返回 `{id: "character_陈伶", name: "陈伶", aliases: ["红心6"]}`，抽取必须输出 `{"entityName": "陈伶"}`，不能创建新实体「红心6」。

### 5.3 same-name-different-type 冲突检测

如果同一个 canonical name 被不同 Entity Type 创建（`concept_梅花K` vs `character_梅花K`、`organization_琼玄` vs `character_琼玄`），`upsertEntity` 自动写入一条 `possible_duplicates`（reason=`type_conflict`），交给 `story review` 人工判断，绝不自动改类型。

---

## 6. 命令一览

```text
story init [--book 书名] [--user-chapter N]   创建项目（默认 userChapter=1，保守）
story import <文件>                           导入整本小说（识别到的所有章节；availableThrough 自动决定）
story build [--from N] [--to N] [--force] [--batch-size N] [--auto-batch] [--no-agent] [--keep-going] [--provider openai|mock] [--retries N]
story review [--auto]                         人工审核：合并/改名/拒绝疑似重复、低置信度事实、冲突
story validate                                完整性校验（引用完整性；不校验章节上限）
story ask <问题> [--chapter N] [--provider openai|mock]  仅基于结构化数据回答（--chapter 临时覆盖阅读进度）
story tui [--provider openai|mock]            交互式问答界面（/chapter N 切换进度，切换会重置 Agent 会话）
story character <人物名>                      人物卡片（严格受 userChapter 约束）
story stats                                   数据量与 LLM 成本统计（availableThrough / builtThrough）
story audit [--chapter N]                     Reader 可见性审计（audit-spoilers 为别名）
```

`--provider` 默认：检测到 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 用 `openai`，否则用 `mock`（离线模板回答器，仅用于验证管道）。

---

## 7. Ask 的行为约束

Ask Agent 的 system prompt 明确要求（并在数据访问层兜底）：

- 只能根据检索到的 `STRUCTURED STORY DATA` 回答；
- 不能使用模型自身关于这本书的知识，不能推测数据中不存在的章节号/能力/事实；
- 当前阅读进度由 `userChapter` 决定，所有工具结果只包含 `<= userChapter` 的数据，不得提及或推测之后的内容；
- 数据不足时必须回答：**当前结构化数据不足以可靠回答这个问题。**（例如“闻人佑最喜欢什么颜色？”）；
- 回答优先给：这人是谁 → 为什么你可能记得他（有画面感的锚点）→ 与主角的重要交集 → 最近一次出现。

`story ask` 的 Intent 识别支持：`RECALL_CHARACTER / LIST_ABILITIES / ABILITY_LOOKUP / CHARACTER_RELATION / CHARACTER_HISTORY / LAST_APPEARANCE / ENTITY_SEARCH / GENERAL_STRUCTURED_QA`。模糊找人（“那个做饭的三师兄是谁？”）走 **别名 + 记忆锚点 + 事实文本** 的结构化检索，全程不碰原文。

LLM 模式下，`story ask` 与 `story tui` 基于 [@earendil-works/pi-agent-core](https://github.com/earendil-works/pi) 的 Agent 循环，由模型自己决定检索调度：

- **工具集**（全部只读结构化数据，受 userChapter 过滤）：`search_entities`（模糊找人）、`get_entity`（完整档案）、`list_abilities`（能力）、`get_relations`（关系）、`list_events`（事件）、`get_entity_index`（全书实体索引）、`get_progress`（阅读进度 + availableThrough/builtThrough）、`list_chapters`（章节目录元信息）、`set_chapter_focus`（选定章节焦点，final cap = min(focus.to, userChapter)）。
- **`story tui`**：基于 [@earendil-works/pi-tui](https://github.com/earendil-works/pi) 的交互式界面——底部输入框提问、上方 Markdown 渲染回答、实时显示工具调用过程、支持多轮连续追问。
  - 斜杠命令：`/help`、`/context`、`/chapter <N>`、`/build`、`/import`、`/validate`、`/review`、`/audit`、`/stats`、`/progress`、`/clear`、`/exit`。
  - **切换章节会重置 Agent 会话**：`/chapter 800` 问过未来信息后再 `/chapter 405`，Agent conversation 被清空，防止未来数据通过上下文泄露。
- 防剧透约束不变：所有工具只经 `StoryRepo` 读结构化表，`chapters` 原文在 Ask/Agent/TUI 代码路径上不存在（e2e 有静态检查）。

---

## 8. 验证结果（mock 离线构建，1~420 章，userChapter=405）

`npm run e2e` 共 36 项断言全部通过，重点覆盖：

- 完整导入 420 章 + 全量构建（无物理截断）；
- **Fact A**：完整 DB 存在 406~420 章未来数据（未来实体/能力/身份/别名/锚点/事件）；
- **Fact B**：userChapter=405 时，`findEntityByName / findByAlias / getEntity / search_entities / listEntities / listFacts / listAbilities / listEvents / listMemoryAnchors / character / ask` 全部看不到未来数据；
- 多章节视角回归：可见数据随 userChapter 单调增长；降低 userChapter 后未来信息立即消失；
- Extraction Batch Range Validation：批 100~110 输出 chapter=120 必须失败；
- same-name-different-type → `possible_duplicates(type_conflict)`；
- entityName canonicalization：别名解析到 canonical name，不新建实体；
- `story audit --chapter 405`：Reader 可见性违规 0。

> ⚠️ mock 是理想化抽取器的替身，只“认识”合成小说里的句子。真实小说请配置 LLM 后重新 `story import + story build --force`，抽取质量以真实模型的输出为准。

---

## 9. 目录结构

```text
src/
  cli.ts                命令行入口
  config.ts             .story/config.json（book / userChapter / llm / build；无 maxChapter）
  novel/parser.ts       章节解析（阿拉伯/中文数字标题；不物理截断）
  db/schema.ts          SQLite schema（无 maxChapter CHECK）
  db/repo.ts            数据访问层（availableThrough/builtThrough + userChapter 可见性过滤）
  llm/                  provider 抽象：pi-ai 适配器 + mock
  build/                prompts、抽取输出校验（Batch Range）、Build pipeline（分批量/续跑/重试）、实体消歧
  ask/                  intent、实体搜索、Recall Card 排序、结构化上下文、模板回答器
  agent/                小说领域 Agent：工具集（NovelTool）、系统提示词、Agent 组装
  tui/                  pi-tui 交互式问答界面 + 斜杠命令处理器
  cmd/                  各子命令
scripts/
  make-fixture.ts       生成合成演示小说（420 章，含未来内容）
  e2e.ts                端到端自动化验证（36 项断言）
```

---

## 10. 已知边界（V0.1 有意不做）

不做：Web UI、阅读器、Neo4j、向量数据库、云同步、账号、多本书/多租户、原文 RAG、Persona / Story Time 双时间轴。实体消歧部分是人工确认（`story review`）。Embedding 检索未引入（结构化检索用词元重叠即可），Ask 阶段 LLM 依赖 `LLM_API_KEY`（无 key 时退化为模板回答器）。

当真实问题答不好时，请优先检查是 **Entity / Alias / Fact / Relation / Ability / MemoryAnchor / Appearance / 消歧** 哪一环缺失，再改进抽取，**而不是给 Ask 加原文 RAG**。Ask 阶段永远不能读取小说正文。
