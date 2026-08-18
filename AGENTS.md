# AGENTS.md — 本项目工作约束（写给后续一切维护者：人类或 AI Agent）

> 开工前必读。违反本节"硬约束"的改动会被判为破坏项目核心承诺。

## 项目一句话
`story-cli`：长篇小说结构化知识 + 无剧透问答 CLI。**Build 阶段**把整本小说按批交给 LLM 抽取成结构化知识（实体/别名/事实/关系/能力/事件/记忆锚点）；**Ask 阶段**只读结构化数据、绝不读原文地帮读者恢复记忆，防剧透边界由阅读进度 `userChapter` 在数据访问层实现。

## 硬约束（不可破坏的不变式）
1. **原文隔离**：`chapters` 表只有 Build 与 `cmd/import.ts` 能读；`src/ask/*`、`src/agent/*`、`src/tui/*` 的代码路径上**不存在**原文（`scripts/e2e.ts` 有静态检查）。
2. **防剧透 = 数据访问层过滤**：所有 Reader 读方法经 `StoryRepo.setUserChapter(n)` 只返回 `chapter <= n` 的数据；不得改成依赖 prompt 自觉。
3. **校验不过不写库**：Build 的抽取输出必须先过 `validateExtractionOutput`（含 Batch Range 校验），再进事务。
4. **数据修正权在 LLM，代码不静默改写输出**：校验失败 → 通过 `feedback` + `buildFixInstruction` 回传给 LLM 让它自己修；**禁止**在代码里悄悄改/丢模型输出（例如把非法 `newEntities.type` 自动改成 concept）。
5. **能力/技能不是实体类型**：`ENTITY_TYPES` 只允许 `character|organization|location|item|concept`；能力走 `abilities` 数组。
6. **`import` 会清空全部旧数据**；Build 的 `failed` 批次不会跳过、重跑自动重试；`failFast` 默认停止后续批次。

## ⚠️ 文档同步约束（本文档的核心目的）
**凡修改以下四个命令（`init` / `import` / `build` / `ask`）的【行为】或【实现】，必须同步更新文档，否则视为未完成：**

- 涉及实现细节（模块/调用链/校验规则/入库流程/工具集/数据表）→ 同步更新 [`docs/commands.md`](docs/commands.md)；
- 涉及用户可见行为（命令参数、输出、配置项、错误提示）→ 同步更新 [`README.md`](README.md)；
- 提交说明里注明"文档已同步"（如 `docs: 同步 commands.md 至 X 改动`）。

相关代码范围（触及即触发同步义务）：
`src/cmd/*`（尤其 `init`/`import`/`build`/`ask`/`stats`/`audit`/`tui`）、`src/build/*`、`src/ask/*`、`src/agent/*`、`src/llm/*`、`src/db/*`、`src/novel/*`、`src/config.ts`、`src/tui/commands.ts`（其 `/build /import /status` 等斜杠命令复用上述流程）。
> 当前命令面（精简后）：CLI = `init import build ask review audit stats tui`（原 `validate` 并入 `stats`、`character` 并入 `ask`、`audit-spoilers` 并入 `audit`）；TUI = `/help /status /config /chapter /build /import /review /audit /clear /exit`（`/status` 合并原 `/context /stats /progress /validate`；`/config` 按组 llm/build/reader 查看与修改配置，LLM/构建项保存后需重启 TUI 生效）。增减命令同样需要同步文档。

## 常用命令
```bash
npm run build   # tsc 编译（改完代码必须保证通过）
npm run dev     # 编译 + 打开 TUI
node dist/scripts/e2e.js   # 端到端验证（见下方环境注意）
node dist/scripts/make-fixture.js   # 生成合成测试小说
```
> package.json 只保留 `build`/`dev` 两个脚本；`fixture`/`e2e` 命令入口已移除，源码保留在 `scripts/`。

## 环境 / 验证注意
- 本仓库在受限文件沙箱下运行时，e2e 中**通过 `execSync` 派生 CLI 子进程并捕获输出**的用例会被沙箱以 `EPERM` 拦截（管道 stdio 限制），属环境限制、非代码回归。改动后至少保证：`tsc` 通过 + e2e 的纯 Node 分支用例（抽取校验/DB 层/静态检查）通过。
- LLM 连接优先取环境变量 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，其次 `.story/config.json` 的 `llm.*`；没有真实 LLM 时用 `--provider mock` 离线验证管道。
