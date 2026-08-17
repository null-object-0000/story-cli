// Build 会话日志：把 Agent 抽取的完整轨迹落盘为 JSONL，供事后分析性能与准确度。
//
// 记录内容（与 llm_logs 性能指标互补，后者记"多快/多少 token"，这里记"发生了什么"）：
//   - extract_start   批次开始（区间、章节数、字数）
//   - llm_turn        每一轮 LLM：system/user/assistant 全文 + usage + 单轮耗时
//   - tool_call       工具调用（名称、参数、结果摘要）
//   - validated       校验通过后的结构化产出统计（实体/事实/关系数量，用于准确度分析）
//   - extract_end     批次结束（成功/失败、总耗时）
//
// 文件位置：<projectRoot>/.story/logs/build/session-<时间戳>-<range>.jsonl
// 每批一个文件；含完整 prompt/回复文本（build 阶段本就读取原文，属正常）。

import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

export interface SessionLogEntry {
  /** 事件类型 */
  t: string;
  /** ISO 时间戳（省略时 write 自动补） */
  ts?: string;
  /** 批次区间（如 31-40） */
  range?: string;
  [k: string]: unknown;
}

export class BuildSessionLogger {
  private dir: string;
  private file: string | null = null;

  constructor(projectRoot: string, subdir = ".story/logs/build") {
    this.dir = join(projectRoot, subdir);
    mkdirSync(this.dir, { recursive: true });
  }

  /** 开启一个批次的新日志文件 */
  open(range: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = join(this.dir, `session-${stamp}-${range}.jsonl`);
  }

  /** 当前日志文件路径（未开启时为 null） */
  get path(): string | null {
    return this.file;
  }

  /** 追加一行 JSON 事件 */
  write(entry: SessionLogEntry): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ ...entry, ts: entry.ts ?? new Date().toISOString() }) + "\n");
    } catch {
      // 日志失败不影响构建
    }
  }
}
