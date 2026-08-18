// Build 阶段的 Agent 化抽取器：基于 pi-agent-core 的 Agent + 工具调用驱动。
//
// 与 Ask（检索问答）不同，这里的 Agent 是"抽取器"：读章节文本 → 产出结构化数据。
// 关键区别：不再把"全量已存在实体清单"注入 prompt（长书后期会吃掉上下文、且 LLM 也
// 记不住），而是给 Agent 一个 search_existing_entities 工具，由 LLM 自己决定何时检索、
// 检索哪些名字（旧角色回归时），用返回的 entityId 复用，避免重复创建实体。
//
// 依赖：provider.getAgentKit() 提供 pi-ai 的 model + streamFn（pi-agent-core Agent 的底座）。

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { StoryRepo } from "../db/repo.js";
import { LlmProvider, ExtractionInput, ExtractionResult } from "../llm/types.js";
import { extractJson } from "../llm/openai.js";
import { EXTRACTION_SYSTEM_PROMPT, buildFixInstruction } from "./prompts.js";
import type { BuildSessionLogger } from "./session-log.js";
import type { NovelTool } from "../agent/tools.js";
import { log, warn } from "../logger.js";

/** 从 pi-ai 的 content 块（thinking + text）中提取纯文本（会话日志用） */
function contentBlocks(blocks: { type: string; text?: string }[]): string {
  return (blocks ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
}

/** 工具调用轮数上限（1 次批量检索 + 最终输出足够；防止模型循环刷工具） */
const MAX_TOOL_TURNS = 4;
/** 单次批量检索的名字上限 */
const MAX_QUERY_NAMES = 40;

/**
 * Agent 化抽取：完整跑一轮 pi-agent-core Agent 循环（含工具调用），
 * 返回结构化 bundle + 累计 usage。输出无法解析为 JSON 时抛错（由 pipeline 重试）。
 */
export async function agentExtract(
  provider: LlmProvider,
  repo: StoryRepo,
  input: ExtractionInput,
  callbacks?: {
    onActivity?: (line: string) => void;
    /** 会话日志器：记录每个 turn/工具调用的完整轨迹（性能与准确度分析用） */
    sessionLog?: import("./session-log.js").BuildSessionLogger;
  }
): Promise<ExtractionResult> {
  const kit = provider.getAgentKit?.();
  if (!kit) {
    throw new Error("当前 provider 不支持 Agent 化抽取（缺少 getAgentKit）");
  }
  const { model, streamFn } = kit;
  const onActivity = callbacks?.onActivity;
  const sessionLog = callbacks?.sessionLog;

  const systemPrompt = `${EXTRACTION_SYSTEM_PROMPT.replaceAll("__START_CHAPTER__", String(input.startChapter)).replaceAll("__END_CHAPTER__", String(input.endChapter))}

## Agent 工作流程（必须遵守）
1. 通读「待抽取章节」（第 ${input.startChapter}~${input.endChapter} 章）。
2. 若文中出现的人物/组织可能【已在知识库中】存在（主角、常驻配角、已有组织等旧实体），
   调用工具 search_existing_entities 批量检索。工具返回结果的 name 是 canonical name（正式名）。
3. 【实体引用契约】命中已有实体后，最终 JSON 必须使用工具返回的 canonical name 作为 entityName/fromName/toName，
   不要使用当前文本中的别名再次创建实体（工具已通过别名定位到该实体）。
4. 未命中检索的旧名字、以及真正第一次登场的新名字，一律作为新实体处理（newEntities 用 name 给出）。
5. 最后严格输出唯一一个 JSON 对象（格式见上）。除 JSON 输出或工具调用外，不要输出其他任何文字。`;

  // 章节文本（与 Ask 不同：build 阶段可读取原文）
  const chapters = input.texts
    .map((t) => `【第${t.chapter}章 ${t.title}】\n${t.text}`)
    .join("\n\n");

  // 校验失败重试：把具体错误 + 定向提示注入本次输出（agent 与注入式共用同一套修复指令）
  const fixBlock = input.feedback ? buildFixInstruction(input.feedback) + "\n\n" : "";

  const userMessage = `${fixBlock}## 此前剧情摘要（供上下文理解，来自上一批抽取）
${input.previousSummary || "（无）"}

## 待抽取章节（第 ${input.startChapter}~${input.endChapter} 章）
${chapters}

请按系统要求开始：先判断是否需要调用 search_existing_entities，然后输出结构化 JSON。`;

  const toolCallCounter = { count: 0 };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: model as any,
      tools: [
        {
          name: "search_existing_entities",
          label: "检索已有实体",
          description:
            "批量检索知识库中已存在的实体。传入章节文本中出现的、你可能想复用的名字（正式名/别名/固定称呼），返回命中实体的 id/name/type 及别名。返回结果中的 name 是 canonical name（正式名）：最终 JSON 必须使用该 canonical name 作为 entityName/fromName/toName，避免用别名创建重复实体。",
          parameters: Type.Object({
            names: Type.Array(Type.String({ description: "待检索的名字列表（最多 40 个）" }), {
              maxItems: MAX_QUERY_NAMES,
              minItems: 1,
            }),
          }),
          execute: async (_id: string, params: any) => {
            const seen = new Set<string>();
            const hits: { id: string; name: string; type: string; aliases: string[] }[] = [];
            for (const raw of (params as { names?: string[] }).names ?? []) {
              const name = raw.trim();
              if (!name || seen.has(name) || hits.length >= 100) continue;
              seen.add(name);
              const e = repo.findEntityByName(name) ?? repo.findByAlias(name);
              if (e) {
                hits.push({
                  id: e.id,
                  name: e.name,
                  type: e.type,
                  aliases: repo.listAliases(e.id).slice(0, 10).map((a) => a.alias),
                });
              }
            }
            return {
              content: [
                {
                  type: "text",
                  text: hits.length
                    ? JSON.stringify(hits)
                    : "未命中任何已有实体：传入的名字可能都是新实体，直接作为新实体处理即可。",
                },
              ],
              details: { count: hits.length },
            };
          },
        },
      ],
    },
    streamFn: streamFn as any,
    toolExecution: "sequential",
    beforeToolCall: async () => {
      toolCallCounter.count++;
      if (toolCallCounter.count > MAX_TOOL_TURNS) {
        return {
          block: true,
          reason: `已达到最大工具调用次数（${MAX_TOOL_TURNS}）。请停止调用工具，直接输出结构化 JSON（检索不到的旧名字视为新实体）。`,
          terminate: true,
        };
      }
      return undefined;
    },
  });

  // 收集最终文本与真实 usage（多轮工具循环需要累加）
  let finalText = "";
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let generatedChars = 0;
  let textStarted = false;
  let turnCount = 0;
  let toolStartAt = 0;
  agent.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      finalText += event.assistantMessageEvent.delta ?? "";
      generatedChars += (event.assistantMessageEvent.delta ?? "").length;
      if (!textStarted) {
        textStarted = true;
        onActivity?.("模型正在生成结构化 JSON...");
      } else if (onActivity && generatedChars % 200 < 20) {
        // 节流：每约 200 字符更新一次进度
        onActivity?.(`模型生成中...（已 ${generatedChars} 字符）`);
      }
    }
    if (event.type === "tool_execution_start") {
      const args = JSON.stringify(event.args ?? {});
      toolStartAt = Date.now();
      onActivity?.(`调用工具 ${event.toolName}(${args.slice(0, 120)}...)`);
      sessionLog?.write({
        t: "tool_call_start", range: input.range,
        tool: event.toolName, args: event.args ?? {}, turn: turnCount,
      });
    }
    if (event.type === "tool_execution_end") {
      const isError = (event as any).isError;
      const summary = isError
        ? "执行失败"
        : `完成（命中 ${((event.result as any)?.details?.count ?? "?")} 个实体）`;
      onActivity?.(`工具 ${event.toolName} ${summary}`);
      const resultText = (event.result as any)?.content?.[0]?.text;
      sessionLog?.write({
        t: "tool_call_end", range: input.range,
        tool: event.toolName, error: isError ?? false,
        result: typeof resultText === "string" ? resultText.slice(0, 2000) : resultText,
        durationMs: Date.now() - toolStartAt, turn: turnCount,
      });
    }
    if (event.type === "agent_end") {
      onActivity?.("Agent 完成，正在解析结构化结果...");
    }
    if (event.type === "message_end" && event.message) {
      const msg = event.message as any;
      const u = msg.usage;
      const turnInput = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
      const turnOutput = (u?.output ?? 0) + (u?.reasoning ?? 0);
      const msgText = contentBlocks(msg.content ?? []) || finalText;
      sessionLog?.write({
        t: "llm_turn", range: input.range, turn: turnCount++,
        role: msg.role ?? "assistant",
        content: msgText.slice(0, 60000),
        usage: u ? { input: turnInput, cached: (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0), output: turnOutput, raw: u } : undefined,
        stopReason: msg.stopReason ?? undefined,
      });
      if (u) {
        inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        cachedTokens += (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        outputTokens += (u.output ?? 0) + (u.reasoning ?? 0);
      } else if (!finalText && msg.stopReason === "stop") {
        const textBlocks = (msg.content ?? []).filter((c: any) => c.type === "text");
        if (textBlocks.length) finalText = textBlocks.map((t: any) => t.text).join("");
      }
    }
  });

  sessionLog?.write({
    t: "extract_start", range: input.range,
    startChapter: input.startChapter, endChapter: input.endChapter,
    chapterCount: input.texts.length,
    chars: input.texts.reduce((s, x) => s + x.text.length, 0),
  });
  sessionLog?.write({ t: "prompt", range: input.range, system: systemPrompt, user: userMessage });

  const tExtract = Date.now();
  try {
    await agent.prompt(userMessage);

    const json = extractJson(finalText);
    if (json === null) {
      throw new Error("Agent 输出无法解析为 JSON");
    }
    if (toolCallCounter.count > 0) {
      log(`  [${input.range}] agent 工具调用 ${toolCallCounter.count} 次（search_existing_entities）`);
    }
    sessionLog?.write({
      t: "extract_end", range: input.range, status: "ok",
      turns: turnCount, toolCalls: toolCallCounter.count,
      durationMs: Date.now() - tExtract,
      usage: { inputTokens, cachedTokens, outputTokens },
    });
    return {
      output: json,
      usage: {
        inputTokens: inputTokens || 0,
        cachedTokens: cachedTokens || 0,
        outputTokens: outputTokens || 0,
      },
    };
  } catch (e) {
    sessionLog?.write({
      t: "extract_end", range: input.range, status: "error",
      turns: turnCount, toolCalls: toolCallCounter.count,
      durationMs: Date.now() - tExtract,
      usage: { inputTokens, cachedTokens, outputTokens },
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/** 某 provider 是否支持 Agent 化抽取 */
export function supportsAgentExtract(provider: LlmProvider): boolean {
  return typeof provider.getAgentKit === "function";
}