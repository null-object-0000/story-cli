// TUI 界面化命令：/settings（交互式设置菜单）与 /login（引导式 LLM 连接向导）
//
// 靠齐 pi code agent：/settings 用 pi-tui 的 SettingsList 组件渲染可搜索的设置菜单；
// /login 用自定义向导组件分步填写 baseUrl/apiKey/model → 测试连接 → 保存。
// 配置写入 .story/config.json（saveConfig），env 变量优先于 config 的语义保持不变。

import {
  Container,
  type Component,
  getKeybindings,
  Input,
  type OverlayHandle,
  type OverlayOptions,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Agent } from "@earendil-works/pi-agent-core";
import { saveConfig, type StoryConfig } from "../../config.js";
import { StoryRepo } from "../../db/repo.js";
import { createProvider } from "../../llm/index.js";

// ── 依赖 ──────────────────────────────────────────

export interface MenuDeps {
  cfg: StoryConfig;
  repo: StoryRepo;
  /** 工具上下文可变引用（/chapter 切换时同步 userChapter） */
  toolCtx?: { userChapter: number; focus: { from: number | null; to: number | null } };
  /** 章节焦点引用（与 Agent 工具共享） */
  focus?: { from: number | null; to: number | null };
  agent?: Agent;
  /** 界面化命令完成后向聊天区输出（如 /login 保存成功摘要） */
  onNotify?: (text: string) => void;
}

// ── 主题 ──────────────────────────────────────────

const cyan = (t: string) => `\x1b[36m${t}\x1b[0m`;
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;

const settingsTheme: SettingsListTheme = {
  label: (t, sel) => (sel ? bold(cyan(t)) : cyan(t)),
  value: (t, sel) => (sel ? bold(yellow(t)) : dim(t)),
  description: (t) => dim(t),
  cursor: "❯ ",
  hint: (t) => dim(t),
};

// ── 通用工具 ──────────────────────────────────────

function maskSecret(v?: string): string {
  return v ? `••••${v.slice(-4)}` : "（未设置）";
}

/** 按点路径写入（cfg.llm.model） */
function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let o = obj;
  for (const p of parts) {
    if (o[p] == null || typeof o[p] !== "object") o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  o[last] = value;
}

function removePath(obj: Record<string, unknown>, key: string): void {
  const parts = key.split(".");
  const last = parts.pop()!;
  let o = obj;
  for (const p of parts) {
    if (o[p] == null || typeof o[p] !== "object") return;
    o = o[p] as Record<string, unknown>;
  }
  delete o[last];
}

const NUMERIC_KEYS = new Set([
  "userChapter",
  "llm.priceInputPerM",
  "llm.priceOutputPerM",
  "llm.priceCachedPerM",
  "build.batchSize",
  "build.retries",
  "build.perChapterOutputTokens",
  "build.maxBatchChapters",
]);
const BOOL_KEYS = new Set(["build.autoBatch", "build.agentExtract", "build.sessionLog"]);

/** 把用户输入写进 cfg（userChapter 即时生效；空字符串语义见注释） */
function applyChange(deps: MenuDeps, id: string, raw: string): boolean {
  const { cfg } = deps;
  if (id === "userChapter") {
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1) return false;
    cfg.userChapter = n;
    applyUserChapter(deps, n);
    saveConfig(cfg);
    return true;
  }
  if (id.startsWith("llm.") || id.startsWith("build.")) {
    if (NUMERIC_KEYS.has(id)) {
      const n = Number(raw.trim());
      if (!Number.isFinite(n)) return false;
      setPath(cfg as unknown as Record<string, unknown>, id, n);
    } else if (BOOL_KEYS.has(id)) {
      setPath(cfg as unknown as Record<string, unknown>, id, raw === "true");
    } else {
      const v = raw.trim();
      if (id === "llm.apiKey" && v === "") return true; // 留空 = 保留原值
      if (v === "") removePath(cfg as unknown as Record<string, unknown>, id); // 留空 = 回退环境变量
      else setPath(cfg as unknown as Record<string, unknown>, id, v);
    }
    saveConfig(cfg);
    return true;
  }
  return false;
}

/** userChapter 变更的即时副作用（对齐 /config 的行为） */
function applyUserChapter(deps: MenuDeps, n: number): void {
  deps.repo.setUserChapter(n);
  if (deps.toolCtx) deps.toolCtx.userChapter = n;
  if (deps.focus && deps.focus.to !== null && deps.focus.to > n) {
    deps.focus.from = null;
    deps.focus.to = null;
  }
  if (deps.agent) deps.agent.reset(); // 清 Agent 历史，防旧数据经对话上下文泄露
}

/** 子菜单：单行文本编辑（Enter 保存 · Esc 取消；数字项校验） */
function textFieldSubmenu(title: string, current: string, type: "string" | "number", done: (v: string | undefined) => void): Component {
  const input = new Input();
  input.setValue(current);
  const error = new Text("", 0, 0);
  const root = new Container();
  root.addChild(new Text(dim(`  ${title}`), 0, 0));
  root.addChild(new Spacer(1));
  root.addChild(input);
  root.addChild(new Spacer(1));
  root.addChild(error);
  input.onSubmit = (v) => {
    const t = v.trim();
    if (type === "number" && t !== "" && !Number.isFinite(Number(t))) {
      error.setText(red(`  请输入有效数字`));
      return;
    }
    done(t);
  };
  input.onEscape = () => done(undefined);
  return root;
}

// ── /settings ─────────────────────────────────────

function buildSettingsItems(deps: MenuDeps): SettingItem[] {
  const { cfg } = deps;
  const field = (id: string, label: string, type: "string" | "number", current: string, desc?: string): SettingItem => ({
    id,
    label,
    currentValue: current,
    description: desc,
    submenu: (_cur, done) => textFieldSubmenu(`${id}（Enter 保存 · Esc 取消）`, current, type, done),
  });
  const cycle = (id: string, label: string, current: string, values: string[], desc?: string): SettingItem => ({
    id,
    label,
    currentValue: current,
    values,
    description: desc,
  });

  return [
    field("userChapter", "reader · userChapter", "number", String(cfg.userChapter), "阅读进度，Ask/TUI 防剧透边界（也可用 /chapter N 即时切换）"),
    field("llm.baseUrl", "llm · baseUrl", "string", cfg.llm?.baseUrl ?? "（未设置）", "OpenAI 兼容端点，如 https://api.deepseek.com/v1；留空回退环境变量"),
    field("llm.apiKey", "llm · apiKey", "string", maskSecret(cfg.llm?.apiKey), "API Key；留空保留原值（清除请用 /logout）"),
    field("llm.model", "llm · model", "string", cfg.llm?.model ?? "（未设置）", "模型名，如 deepseek-chat；留空回退环境变量"),
    cycle("llm.thinkingFormat", "llm · thinkingFormat", cfg.llm?.thinkingFormat ?? "auto", ["auto", "deepseek", "zai", "qwen", "openrouter", "openai"], "推理协议（deepseek/qwen 等自定义端点必须正确）"),
    cycle("llm.extractReasoning", "llm · extractReasoning", cfg.llm?.extractReasoning ?? "off", ["off", "low", "medium", "high"], "构建抽取时的思考强度（Ask 对话不受影响）"),
    field("build.batchSize", "build · batchSize", "number", String(cfg.build?.batchSize ?? 1), "固定模式每批章节数"),
    field("build.retries", "build · retries", "number", String(cfg.build?.retries ?? 2), "批内失败重试次数"),
    cycle("build.autoBatch", "build · autoBatch", String(cfg.build?.autoBatch ?? false), ["true", "false"], "按上下文自动合并批次"),
    field("build.perChapterOutputTokens", "build · perChapterOutputTokens", "number", String(cfg.build?.perChapterOutputTokens ?? 260), "每章结构化输出的 token 估算（输出预算）"),
    field("build.maxBatchChapters", "build · maxBatchChapters", "number", String(cfg.build?.maxBatchChapters ?? 60), "单批章节数上限"),
    cycle("build.agentExtract", "build · agentExtract", String(cfg.build?.agentExtract ?? true), ["true", "false"], "Agent 化抽取（false 回退注入实体清单）"),
    cycle("build.sessionLog", "build · sessionLog", String(cfg.build?.sessionLog ?? true), ["true", "false"], "构建会话日志落盘 .story/logs/build/"),
  ];
}

function overlayOptions(): OverlayOptions {
  return { width: "62%", maxHeight: "80%", anchor: "center", margin: { top: 1, bottom: 1 } };
}

function closeOverlay(handle: OverlayHandle, tui: TUI): void {
  handle.hide();
  tui.requestRender();
}

/** /settings：交互式设置菜单（Enter/Space 修改 · / 搜索 · Esc 关闭） */
export function openSettingsOverlay(tui: TUI, deps: MenuDeps): void {
  const items = buildSettingsItems(deps);
  let realApiKey = deps.cfg.llm?.apiKey ?? "";
  let handle: OverlayHandle | null = null;
  const list = new SettingsList(
    items,
    12,
    settingsTheme,
    (id, raw) => {
      const ok = applyChange(deps, id, raw);
      if (id === "llm.apiKey") {
        const v = raw.trim();
        if (v && ok) realApiKey = v;
        list.updateValue(id, maskSecret(realApiKey));
      } else if (!ok) {
        const orig = items.find((i) => i.id === id)?.currentValue;
        if (orig !== undefined) list.updateValue(id, orig); // 非法输入恢复显示
      }
      tui.requestRender();
    },
    () => {
      if (handle) closeOverlay(handle, tui);
    },
    { enableSearch: true }
  );
  handle = tui.showOverlay(list, overlayOptions());
  handle.focus();
  tui.requestRender();
}

// ── /login ────────────────────────────────────────

type WizardRow = { key: string; label: string; value: string; action?: boolean };

/**
 * /login：引导式 LLM 连接向导（对齐 pi code agent 的 /login 交互模式）。
 * 步骤：baseUrl → apiKey → model → 测试连接 → 保存并完成；Esc 取消。
 * 保存只写 .story/config.json 的 llm.*，环境变量优先语义不变。
 */
class LoginWizard implements Component {
  private sel = 0;
  private status = "";
  private busy = false;
  private editing: { input: Input } | null = null;
  private vals = { baseUrl: "", apiKey: "", model: "" };

  constructor(
    private deps: MenuDeps,
    private onClose: () => void,
    private onSaved: (summary: string) => void,
    private requestRender: () => void
  ) {
    this.vals.baseUrl = deps.cfg.llm?.baseUrl ?? "";
    this.vals.apiKey = deps.cfg.llm?.apiKey ?? "";
    this.vals.model = deps.cfg.llm?.model ?? "";
  }

  private rows(): WizardRow[] {
    return [
      { key: "baseUrl", label: "baseUrl", value: this.vals.baseUrl || dim("（留空用环境变量）") },
      { key: "apiKey", label: "apiKey", value: this.vals.apiKey ? yellow(maskSecret(this.vals.apiKey)) : dim("（未设置）") },
      { key: "model", label: "model", value: this.vals.model || dim("（留空用环境变量）") },
      { key: "test", label: "▶ 测试连接", value: "", action: true },
      { key: "save", label: "💾 保存并完成", value: "", action: true },
    ];
  }

  render(width: number): string[] {
    if (this.editing) {
      return [
        dim("  编辑中（Enter 保存 · Esc 取消）"),
        "",
        ...this.editing.input.render(width),
        "",
      ];
    }
    const rows = this.rows();
    const lines = [bold(cyan("登录 LLM（OpenAI 兼容）")), ""];
    rows.forEach((r, i) => {
      const sel = i === this.sel;
      const prefix = sel ? cyan("❯ ") : "  ";
      const label = r.label.padEnd(12);
      lines.push(`${prefix}${cyan(label)}  ${r.value}`);
    });
    lines.push("", dim(this.status || "填写连接信息 → 测试 → 保存（Esc 取消）"), "");
    lines.push(dim("↑/↓ 选择 · Enter 编辑/执行 · Esc 取消"));
    return lines;
  }

  invalidate(): void {
    // 无缓存渲染状态
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (this.editing) {
      this.editing.input.handleInput(data);
      this.requestRender();
      return;
    }
    const kb = getKeybindings();
    const n = this.rows().length;
    if (kb.matches(data, "tui.select.up")) {
      this.sel = (this.sel + n - 1) % n;
    } else if (kb.matches(data, "tui.select.down")) {
      this.sel = (this.sel + 1) % n;
    } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
      this.activate();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onClose();
    }
    this.requestRender();
  }

  private activate(): void {
    const row = this.rows()[this.sel];
    if (!row) return;
    if (row.action) {
      if (row.key === "test") void this.runTest();
      else if (row.key === "save") this.save();
      return;
    }
    const input = new Input();
    const key = row.key as "baseUrl" | "apiKey" | "model";
    input.setValue(key === "apiKey" ? "" : this.vals[key]);
    input.onSubmit = (v) => {
      this.vals[key] = v.trim();
      this.editing = null;
      this.requestRender();
    };
    input.onEscape = () => {
      this.editing = null;
      this.requestRender();
    };
    this.editing = { input };
    this.requestRender();
  }

  private async runTest(): Promise<void> {
    this.busy = true;
    this.status = "⏳ 正在测试连接…";
    this.requestRender();
    const merged: StoryConfig = {
      ...this.deps.cfg,
      llm: {
        ...this.deps.cfg.llm,
        baseUrl: this.vals.baseUrl || undefined,
        apiKey: this.vals.apiKey || undefined,
        model: this.vals.model || undefined,
      },
    };
    try {
      const { provider, mode } = createProvider(merged);
      if (mode === "mock") {
        this.status = "⚠️ 连接信息不完整，将使用 mock（离线）";
      } else {
        const r = await provider.complete([{ role: "user", content: "你好，请只回复：OK" }], { stream: false, reasoning: "off" });
        this.status = `✅ 连接正常（${r.model}：${r.content.trim().slice(0, 40) || "（空）"}）`;
      }
    } catch (e) {
      this.status = `❌ ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.busy = false;
      this.requestRender();
    }
  }

  private save(): void {
    const { baseUrl, apiKey, model } = this.vals;
    if (!baseUrl.trim() && !apiKey.trim() && !model.trim()) {
      this.status = "❌ 没有可保存的连接信息（请至少填写一项）";
      this.requestRender();
      return;
    }
    const llm: NonNullable<StoryConfig["llm"]> = { ...this.deps.cfg.llm };
    if (baseUrl.trim()) llm.baseUrl = baseUrl.trim();
    else delete llm.baseUrl;
    if (apiKey.trim()) llm.apiKey = apiKey.trim();
    else delete llm.apiKey;
    if (model.trim()) llm.model = model.trim();
    else delete llm.model;
    this.deps.cfg.llm = llm;
    saveConfig(this.deps.cfg);
    const summary = [
      "## 登录完成",
      `- \`baseUrl\` = \`${llm.baseUrl ?? "（未设置）"}\``,
      `- \`apiKey\` = \`${llm.apiKey ? maskSecret(llm.apiKey) : "（未设置）"}\``,
      `- \`model\` = \`${llm.model ?? "（未设置）"}\``,
      "> LLM/构建配置已写入 `.story/config.json`，退出并重新运行 `npm run dev` 后生效。",
    ].join("\n");
    this.onSaved(summary);
    this.onClose();
  }
}

/** /login：打开 LLM 连接向导 */
export function openLoginOverlay(tui: TUI, deps: MenuDeps): void {
  const wizard = new LoginWizard(
    deps,
    () => {
      handle.hide();
      tui.requestRender();
    },
    (summary) => deps.onNotify?.(summary),
    () => tui.requestRender()
  );
  const handle = tui.showOverlay(wizard, overlayOptions());
  handle.focus();
  tui.requestRender();
}

/** 供 commands.ts 复用：/logout 是否已清除连接内容（清除后由调用方 saveConfig） */
export function clearLlmConnection(cfg: StoryConfig): boolean {
  const llm = cfg.llm;
  const had = Boolean(llm && (llm.baseUrl || llm.apiKey || llm.model));
  if (llm) {
    delete llm.baseUrl;
    delete llm.apiKey;
    delete llm.model;
  }
  return had;
}
