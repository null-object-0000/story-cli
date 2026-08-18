# story 关键命令实现文档（init / import / build / ask）

> 本文档说明四个关键命令**做了什么、怎么实现的**（代码路径级别）。
> 配套阅读：[README.md](../README.md)（用户视角的使用说明）、`src/db/schema.ts`（数据表）。
>
> **⚠️ 同步约束**：本文档与代码强绑定。任何修改这四条命令**行为或实现**的迭代，必须同步更新本文档（详见仓库根 [AGENTS.md](../AGENTS.md)）。

---

## 0. 总览：命令 → 入口 → 核心模块

| 命令 | 命令入口 | 核心实现 | 直接写入/读取的表 |
|---|---|---|---|
| `story init` | `src/cli/commands/init.ts` → `cmdInit` | `initializeProject` → `config.initProject` + `new StoryRepo` | 创建 `.story/config.json`、`story.db`（建 schema） |
| `story import <文件>` | `src/cli/commands/import.ts` → `cmdImport` | `novel/parser`（`decodeNovel`+`parseNovel`）→ `resetAllData` → `repo.replaceChapters` | 清空 14 张业务表 → 写 `chapters` |
| `story build` | `src/cli/commands/build.ts` → `cmdBuild` | `build/pipeline.ts` → `runBuild`（分批→抽取→校验→重试→事务入库） | 全部结构化表 + `batch_state` + `llm_logs` |
| `story ask <问题>` | `src/cli/commands/ask.ts` → `cmdAsk` | Agent 路径：`reader/agent.ts` → `askAgent`；传统路径：`reader/answer.ts` → `answerQuestion` | 只读全部结构化表（受 `userChapter` 过滤）+ 写 `llm_logs` |

三个贯穿性概念（详见 README §4）：

- `availableThrough` = `MAX(chapters.chapter)`，小说已导入到哪里；
- `builtThrough` = `batch_state` 中 done 批次的最高结束章节，结构化已构建到哪里；
- `userChapter` = 读者读到哪里，是 Ask/TUI/Agent 唯一的防剧透过滤边界（数据访问层实现，不是 prompt 自觉）。

---

## 1. `story init` — 创建项目配置与数据库

### 做什么
在当前目录创建 `.story/` 项目：写 `config.json`、初始化 SQLite `story.db`（建全部表）、写入书目 meta。

### 实现路径
```
cmdInit
 └─ initializeProject({ book, userChapter })
     ├─ ensureProjectDir()          # mkdir .story
     ├─ initProject(opts)           # 写 .story/config.json（含 build.* 默认值，不再存 maxChapter）
     ├─ new StoryRepo(dbPath)       # 打开 DB，执行 SCHEMA_SQL 建表
     └─ repo.setMeta("book", ...)   # meta 表记录书目
 └─ logInitSummary(cfg)             # 打印完成摘要
```

### 关键点
- **不再存 `maxChapter`**（V0.1 收口）：schema 不把最大章节号编译进 CHECK，章节数变化永远不会触发重建 DB。
- `userChapter` 默认 1（保守，Ask 只返回第 1 章前的数据）。
- `initializeProject` / `logInitSummary` 同时被 **TUI 未初始化时的自动初始化**复用（`src/cli/tui/app.ts`）。

---

## 2. `story import <文件>` — 导入整本小说

### 做什么
解析小说文件 → **清空全部旧数据** → 把识别到的所有章节（含正文）写入 `chapters` 表。整本导入、不物理截断。

### 实现路径
```
cmdImport(path)
 ├─ readFileSync(path)             # 原始 buffer
 ├─ decodeNovel(buf)               # UTF-8 严格解码 → 失败回退 GBK → 再失败 latin1
 ├─ parseNovel(text)               # 逐行识别章节标题
 ├─ resetAllData(repo)             # 单事务 DELETE 14 张业务表（保留 meta）
 ├─ repo.setMeta("book" | "source_file")
 └─ repo.replaceChapters(chapters) # 写 chapters 表（number/title/text/chars）
```

### 章节解析 `novel/parser.ts`
- 标题正则：阿拉伯数字 `第\s*(\d{1,6})\s*章` 与中文数字 `第四百零五章`（`chineseNumeralToNumber` 支持到 9999）；
- 重复章节号：保留先出现者，`duplicates` 计数并告警；
- 按章节号排序去重；标题行之前的杂项记为 `preambleLines`（不导入）；
- `availableThrough` 由导入结果自动决定，无需配置。

### 关键点
- **清空全部旧数据**：`resetAllData` 删除 `chapters / entities / aliases / facts / relations / abilities / events / memory_anchors / entity_appearances / possible_duplicates / conflicts / llm_logs / batch_state / review_log`。重复 import 会丢失上次构建结果。
- 防剧透边界不在这里：导入的是整本，边界由 Reader 层 `userChapter` 控制。

---

## 3. `story build` — 分批量 LLM 抽取 → 校验 → 事务入库

### 做什么
把 `chapters` 原文按批交给 LLM 抽取结构化知识（实体/别名/事实/关系/能力/事件/记忆锚点），逐批校验、入库，支持断点续跑、失败重试（反馈修复）、成本统计与会话日志。

### 实现路径
```
cmdBuild
 └─ runBuild(repo, provider, opts)            # build/pipeline.ts
     ├─ 1. 计算范围：from/to = clamp(1..dbMax)；dbMax = availableThrough
     ├─ 2. 生成批次：
     │     · 固定模式（--batch-size / config.build.batchSize）：每批 N 章
     │     · 自适应模式（autoBatch）：按上下文预算动态合并
     │         inputBudget = (contextWindow − maxTokens) × 0.9 − 固定开销(3000)
     │         单批上限 min(maxBatchChapters, 输出预算折算的章数)
     ├─ 3. 断点续跑：跳过 status=done 的批次（batch_state）+ 按"每章都被 done 覆盖"判断
     │         （--force 忽略；failed 批次不会被跳过，下次 build 自动重试）
     ├─ 4. 逐批串行 processBatch：
     │     a. 读取章节文本（按输入预算折算每章字符预算，超长截断）
     │     b. 抽取：Agent 化（默认）或 注入式
     │         · Agent 化 agentExtract（build/agent-extractor.ts）：
     │             pi-agent-core Agent + search_existing_entities 工具
     │             模型自己决定检索哪些已有实体（返回 canonical name，避免重复建实体）
     │         · 注入式（--no-agent）：buildRelevantContext 只注入本批文本实际出现的实体清单
     │     c. 滚动摘要 rollPreviousSummary：取 start 前最近一个 done 批次的 batchSummary
     │     d. 校验 validateExtractionOutput（build/validation.ts）
     │         · runtime schema（结构/类型/confidence）
     │         · 【Batch Range】所有 chapter 必须在 [start, end] 内（防止幻觉章节号）
     │     e. 失败重试（重试次数 = config.build.retries，默认 2）：
     │         · 校验失败 → 把错误回填为 feedback，注入下次 prompt（见下"修复机制"）
     │         · 网络/超时类错误 → 仅简单重试
     │     f. 校验通过 → 单事务入库（见下"入库"）→ markBatch(status=done, counts, batchSummary)
     │         · addLlmLog（usage/耗时/重试次数）
     │     g. 仍失败 → markBatch(status=failed) + addLlmLog(success=0, error) → 批次记 error 原因
     ├─ 5. 串行执行：批间存在强依赖（实体注入 + 滚动摘要），并发参数已忽略
     └─ 6. failFast（默认 true）：某批失败后停止后续批次（--keep-going 可继续）
```

### 入库（单事务，全部同步）
```
repo.db.exec("BEGIN")
  newEntities → upsertEntity（same-name-different-type 自动写 possible_duplicates）
  aliases      → addAlias（clash 时 aliasClashToDuplicate 转疑似重复）
  facts        → addFact
  relations    → addRelation
  abilities    → addAbility
  events       → addEvent
  memoryAnchors→ addMemoryAnchor
  possibleDuplicates → addPossibleDuplicate
  conflicts    → addConflict
  countAppearances → entity_appearances（按实体名/别名统计出场次数）
repo.db.exec("COMMIT")   # 任一步异常 → ROLLBACK，批次记 failed
```

### 修复机制（设计原则：数据修正权在 LLM，代码不静默改写）
- 校验失败 → `buildValidationFeedback(raw, error)` **点名**非法条目（如"请从 newEntities 中删除：杀戮舞曲"）→ 作为 `input.feedback` 传入下一次抽取；
- 下次 prompt 经 `buildFixInstruction(feedback)`（`build/prompts.ts`）注入"校验器原文 + 定向提示"；
- **代码绝不静默改写/丢弃模型输出**（这是与"宽容修复"方案明确区分的设计决定）；若重试耗尽仍失败 → 批次响亮失败并记录原因。
- 校验硬规则示例：`newEntities.type` 只允许 `character|organization|location|item|concept`，能力/技能禁止作为实体类型（能力走 `abilities` 数组）。

### 可观测性
- **会话日志**：Agent 化抽取时每批完整轨迹（prompt/回复/工具调用/usage）落盘 `.story/logs/build/session-<时间戳>-<range>.jsonl`（`build/session-log.ts`）；
- **性能指标**：`llm_logs` → `buildMetrics("extract")` 汇总 千字速度 / 千字 token / 缓存命中率 / 预估费用（`config.resolveLlmPrices` + `costEstimate`）。

---

## 4. `story ask <问题>` — 仅基于结构化数据的无剧透问答

### 做什么
不读原文、只检索结构化数据、严格受 `userChapter` 过滤地回答"这人是谁/记得什么/有什么能力/什么关系"等记忆恢复问题；数据不足时明确回答"当前结构化数据不足以可靠回答这个问题"。

### 入口
```
cmdAsk(question, flags)
 ├─ provider = createProvider(...)          # openai | mock
 ├─ userChapter = --chapter N ?? cfg.userChapter（--chapter 一次性临时覆盖，不写配置）
 ├─ repo.setUserChapter(userChapter)        # 数据访问层过滤边界
 └─ 两条路径（二选一）
```

### 路径 A：Agent 驱动（LLM 模式 + provider 支持 `getAgentKit`）
```
askAgent(provider, repo, cfg, question)     # reader/agent.ts
 ├─ new Agent(pi-agent-core) + buildNovelTools(toolCtx)   # reader/tools.ts
 │     工具（全部只读结构化、受 userChapter 过滤）：
 │     search_entities / get_entity / list_abilities / get_relations / list_events /
 │     get_entity_index / get_progress / list_chapters / set_chapter_focus
 ├─ agent.steer() 注入"当前阅读进度第 N 章，不得提及之后内容"
 ├─ agent.prompt(question)                  # 流式输出 → stdout；MAX_TOOL_TURNS=8 防循环
 └─ 返回 answer + tokens → recordAskLog
```

### 路径 B：传统管道（无 Agent 支持 或 mock 模式）
```
answerQuestion({ repo, cfg, provider, mode, question })   # reader/answer.ts
 ├─ 1. 能力名预匹配：问题包含已知能力名 → 定位其 Owner 实体
 ├─ 2. Intent：classifyIntent(question)     # reader/intent.ts（启发式正则）
 │      RECALL_CHARACTER / LIST_ABILITIES / ABILITY_LOOKUP / CHARACTER_RELATION /
 │      CHARACTER_HISTORY / LAST_APPEARANCE / ENTITY_SEARCH / GENERAL_STRUCTURED_QA
 ├─ 3. 实体解析：searchEntities(repo, question, topK)   # reader/search.ts
 │      · 名称/别名 精确/包含 + shingle(2) 重叠打分（身份/锚点/事件/关系文本参与）
 │      · "主角"关键词命中 → 主角提权
 ├─ 4. 弱命中兜底：LLM 模式无命中或分数过低 → 给 LLM 结构化实体索引（buildEntityIndexDigest）做二次消歧
 ├─ 5. 构造上下文 buildContext → StructuredContext（reader/context.ts）
 │      EntityCard = 别名 + 身份/性格事实 + RecallAnchor（reader/recall.ts 排序：importance/
 │      memorability/主角相关性/最近性 加权）+ 关系 + 近期事件
 ├─ 6. 充分性判断：
 │      · 无任何命中 → 不足
 │      · 属性性问题（"最喜欢什么颜色"）且上下文不覆盖 → 不足
 ├─ 7. 回答：
 │      · LLM：ASK_SYSTEM_PROMPT（注入 userChapter）+ StructuredContext JSON → provider.complete
 │      · mock：templateAnswer 按 intent 模板回答
 └─ recordAskLog → llm_logs(phase=ask)
```

### 防剧透实现（Ask 的核心约束）
- **数据访问层过滤**：`StoryRepo.setUserChapter(n)` 后，所有读方法（`listEntities / findEntityByName / findByAlias / getEntity / listFacts / listRelations / listAbilities / listEvents / listMemoryAnchors / listAppearances / listChapterMeta`）只返回 `chapter / first_seen_chapter / from_chapter <= n` 的数据；未来实体"存在本身"也表现为不存在。
- **Ask 代码路径上不存在原文**：`chapters` 表只有 Build/`src/cli/commands/import.ts` 能读；`scripts/e2e.ts` 有静态检查（`src/reader|src/cli/tui` 不得出现 `getChapterText`/`FROM chapters` 等）。
- TUI 切换章节（`/chapter N`）会 **reset Agent 会话**，防止未来数据经对话上下文泄露。

### TUI 问答呈现（app.ts / askAgent）
- 呈现顺序对齐 pi code agent：**用户输入 → 工具调用逐条（🔧 调用 / ✓ 完成）→ 最终回答在最后**流式输出。
- 工具调用 start 与 end 时都会把正在渲染的回答移到流底部（模型可能同轮"先答后调工具"，保证工具行聚在一起、回答永远在最后）。
- 非流式 / 推理模型（如 glm 把回答塞进 `reasoning_content`）的兜底：`message_end` 只把最终消息的文本/thinking **记录下来不立即渲染**，agent 结束后仍无流式文本时才用它当回答（避免中间消息/推理内容提前出现在工具调用之前）。
- 模型始终未返回文本时，诊断信息会带上**工具调用统计**（次数/失败数/失败工具名）帮助定位；系统提示词（`system-prompt.ts` 规则 8）要求工具调用带合法参数、失败后重试或基于已有数据回答、绝不返回空回复。
- **空回答二次机会**（app.ts / askAgent）：模型做过工具调用却未返回任何文本（含最后消息兜底）时，追加一条明确指令要求它直接基于已检索数据回答或明确说数据不足（禁止再调工具、禁止空内容）——把"查到了却忘了总结"的常见情况自动救回。
- **回答质量**：系统提示词（`system-prompt.ts` 回答风格）对列举/概览类问题（"有哪些神道/技能"）要求分组精炼、不全量罗列、不用分隔线；TUI markdown 主题把 `hr`（`---`）渲染成轻量 `· · ·` 分隔点，避免满屏横线。

### Ask 会话日志（排查用）
- 每轮 Ask（TUI 问答 与 `story ask`）把 agent 事件落盘 `.story/logs/ask/session-<时间戳>.jsonl`（`src/reader/ask-log.ts` 的 `AskSessionLogger` + `logAskEvent`）：用户问题、每条助手消息（text / thinking / toolCalls / stopReason）、工具调用参数与结果、最终答案、耗时与工具统计。
- 用途：排查模型空回答 / 卡住 / 工具调用异常——直接看模型每轮到底输出了什么（text 还是 thinking、是否真为空）。
- 只记录结构化数据与对话文本，**不落盘 chapters 原文**（符合原文隔离硬约束）。
- TUI 里"⏳ 思考中…"每 3s 更新一次已等待秒数，避免误以为卡死。

---

## 5. 关键设计原则速查（改这块代码前必读）

1. **Build 可读原文，Ask/TUI/Agent 绝不读原文** —— 职责物理隔离，不是靠 prompt。
2. **防剧透边界 = `userChapter` 数据访问层过滤**，与导入范围无关。
3. **校验不过不写库**：任何抽取输出必须过 `validateExtractionOutput`，否则不进事务。
4. **校验错误的修复 = 反馈给 LLM**（`feedback` + `buildFixInstruction`），代码不得静默改写/丢弃模型输出。
5. **能力/技能不是实体类型**：`ENTITY_TYPES` 仅 `character|organization|location|item|concept`。
6. **import 会清空全部旧数据**；build 的 `failed` 批次不会被跳过，重跑自动重试。
7. **三个概念不要混**：`availableThrough`（导入到哪）/ `builtThrough`（构建到哪）/ `userChapter`（读到哪）。

---

## 6. TUI 界面化命令（/settings /login /logout）

靠齐 pi code agent。`/settings`、`/login`、`/build` 打开时通过 `setLayoutRoot` 用「顶栏 + 聊天历史 + 面板」重建布局根——**只把输入区（editor/bottomBar）替换为面板，顶栏和聊天历史保留可见**（不是整屏接管），关闭时还原基座布局并把焦点还给输入框。面板自身不画冗余标题（组件底部自带操作提示）。实现全部在 `src/cli/tui/menus.ts`，命令入口/补全在 `src/cli/tui/commands.ts`（`SLASH_COMMANDS` 注册），切换能力由 `app.ts` 经 `CommandContext.ui` 注入（`openSettings` / `openLogin` / `openBuild`；`MenuDeps` 携带 `topBar`/`scrollView`/`layoutRoot`/`focusTarget`）。注意：切换发生在 `onSubmit` 完成之后（`setTimeout(0)`），避免被末尾的 `setFocus(editor)` 抢走焦点；`/settings`/`/login`/`/build` 属 UI 命令（`UI_COMMANDS`），`CommandResult.noEcho=true`，**不在聊天区回显命令与结果**。

### `/settings` — 交互式设置菜单（输入区替换为面板）
- `openSettingsView(tui, deps)` 用 pi-tui `SettingsList` 组件渲染**通用配置**（reader.userChapter + build.*，**不含 llm.**——LLM 连接归 `/login`，凭据清除归 `/logout`）。
- Enter/Space 修改：数字走 `Input` 子菜单（子菜单内校验数字合法性），布尔（autoBatch / agentExtract / sessionLog）走 `values` 循环；`/` 启用搜索过滤；Esc 返回聊天视图。
- 每次改动立即 `saveConfig` 写 `.story/config.json`；`userChapter` 即时生效（`repo.setUserChapter` + 工具上下文 + `agent.reset()` 清历史防泄露）。

### `/login` — 引导式 LLM 连接向导
- `openLoginView(tui, deps)` 把输入区替换为自定义 `LoginWizard` 面板，分步：`baseUrl` → `apiKey` → `model` → `thinkingFormat` → **测试连接** → **保存并完成**；Esc 返回。`thinkingFormat` 用 Enter 循环切换 `auto|deepseek|zai|qwen|openrouter|openai`（glm 系选 `zai`、deepseek 系选 `deepseek`；`auto` 自动识别）。
- 测试连接：用当前输入合并出临时 config → `createProvider(cfg)` → `provider.complete([…], { stream:false, reasoning:"off" })`，成功显示模型名与回复、失败显示错误；连接信息不完整则提示将用 mock。
- 保存：写入 `cfg.llm.{baseUrl,apiKey,model,thinkingFormat}` 并 `saveConfig`；留空项删除（回退环境变量）；保存后调用 `onLlmChanged`（app.ts 的 `reloadLlm`）**重建 provider/agent 并实时换入，无需重启**；完成后摘要经 `onNotify` 渲染到聊天区。
- 语义：环境变量 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 始终优先于 config（`resolveLlmSettings`），`/login` 只是把连接写进 config。
- **推理协议（glm 空回答问题）**：`src/llm/openai.ts` 的 `deepseekCompat` 会把 glm 系模型自动识别为 `thinkingFormat=zai` —— pi-ai 在 zai 格式下默认发送 `thinking:{type:"disabled"}`，模型回答才落在 `content`（否则 glm 会把整段回答塞进 `reasoning_content`、`content` 为空导致 Agent 拿不到文本）。另在 `app.ts` / `askAgent` 加了安全网：最终消息 `content` 为空时用 `thinking` 块兜底当回答。

### `/logout` — 清除已保存的 LLM 连接凭据
- `clearLlmConnection(cfg)` 删除 `llm.baseUrl / llm.apiKey / llm.model`（保留价格与推理参数），`saveConfig` 后调用 `ctx.ui.reloadLlm()` 实时重建（回到离线/mock 模式），返回摘要。
- 环境变量中的凭据不受影响。

### `/build` — 独立构建面板
- `case "build"`（`src/cli/tui/commands.ts`）打开 `openBuildView`（`menus.ts`）构建面板，把输入区替换为面板：进度条/百分比、失败批次数、实时 token 消耗 + ETA、当前批次运行日志实时渲染；**构建中不能干别的，Esc 取消**（pipeline `runBuild` 新增 `signal` 选项，批间检查、当前批结束后停止），完成后 Esc 返回。
- **进度条长度随面板/终端宽度自适应**（`BuildPanelHandle.width()`），并实时显示本次构建累计 token 消耗（`buildMetrics("extract")` 快照差量）。
- 面板复用原有进度与汇总 markdown 格式化；`/build` 属 UI 命令（`UI_COMMANDS`），`CommandResult.noEcho=true`，**聊天区零痕迹**（无回显、无「执行中…」）；**结束后面板显示简洁版结果（避免长表格溢出），完整批次明细经 `ctx.onNotify` 输出到聊天区**（聊天区可滚动查看，关闭面板后仍有记录）。
- `/build` 各 flag（`--from/--to/--force/--batch-size/--auto-batch/--no-agent/--keep-going`）与配置组 `build.*` 的语义不变。

### 实时生效说明
- `reader.userChapter`、`build.*`：本身就被 `/ask` `/build` 等实时读取，改动即时生效。
- `llm.*`（provider/agent）：`/login` 保存与 `/logout` 后通过 `reloadLlm`（app.ts）重建 provider + agent（`createProvider` → `createStoryAgent`/`createOfflineAgent`）并换入运行中的应用，**全程无需重启 TUI**。
