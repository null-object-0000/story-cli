# Architecture — StoryPack 目录与数据流

> 本文档描述仓库结构与核心数据流（模块级）。命令级实现细节见 [commands.md](commands.md)。

## 核心数据流

```
Novel（整本小说）
   ↓ init（story init <文件>：initializeProject + cmdImport，src/cli/commands/{init,import}.ts）
chapters 原文（仅 Build 可读）
   ↓ build（src/build/ 抽取 pipeline）
Story Data（结构化知识：实体/别名/事实/关系/能力/事件/记忆锚点）
   ↓
Reader @ Chapter N（src/reader/，全部经 StoryRepo.setUserChapter(n) 过滤）
   ↓
CLI / TUI（src/cli/）
```

## 目录结构

```
src/
├── build/    # 把小说构建成 Story Data（agent-extractor / pipeline / prompts /
│             #   resolution / validation / session-log）
├── reader/   # “Story Knowledge @ Chapter N”：Reader Agent（agent / system-prompt /
│             #   tools）+ 问答管道（answer / context / intent / recall / search）
├── db/       # schema + repo（唯一数据访问层；防剧透过滤在这里实现）
├── novel/    # 原始小说解析 / 导入
├── llm/      # 模型适配（openai / types；pi-ai 底座）
├── cli/      # CLI 入口（index）+ 命令（commands/）+ TUI 交互模式（tui/）与提示组件
├── config.ts / env.ts / logger.ts / util.ts
```

## 关键边界

- **原文隔离**：`chapters` 表只有 Build 与 `src/cli/commands/import.ts` 能读；`src/reader/*` 与 `src/cli/tui/*` 的代码路径上不存在原文。
- **防剧透 = 数据访问层过滤**：所有 Reader 读方法经 `StoryRepo.setUserChapter(n)` 只返回 `chapter <= n` 的数据。
- **产品概念命名**：`src/reader/` 承载“在用户当前阅读进度下消费 Story Knowledge”的 Reader 能力——Web、小程序等未来调用方都消费这层，而不仅是 CLI 的 `ask`。

## 一句话

Build 生产 Story Data，Reader 以 `userChapter` 为边界消费 Story Data，CLI/TUI 只是 Reader 能力的一种交互界面。
