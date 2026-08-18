// TUI 界面化命令：/settings（交互式设置菜单）与 /login（引导式 LLM 连接向导）
//
// 靠齐 pi code agent：/settings 与 /login 打开时【切换整个视图】到设置界面（全屏接管，
// 不再用叠在聊天内容之上的浮动弹窗），关闭时还原基座布局。这样不会干扰内容呈现区。
// /settings 只放通用配置（reader/build），LLM 连接相关只走 /login（填写 + 测试）与 /logout（清除）。
// 配置写入 .story/config.json（saveConfig），env 变量优先于 config 的语义保持不变。

import {
  type Component,
  getKeybindings,
  Input,
  type MarkdownTheme,
  Markdown,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Text,
  type TUI,
  type ViewportTUI,
  VStack,
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
  /** LLM 配置变更后重建 provider/agent（/login 保存成功后调用；实现见 app.ts reloadLlm） */
  onLlmChanged?: () => Promise<{ ok: boolean; error?: string; mode?: "llm" | "mock" }>;
  /** settings/login 打开时仍保留显示：顶栏（书名/进度） */
  topBar: Component;
  /** settings/login 打开时仍保留显示：聊天历史区 */
  scrollView: Component;
  /** 基座布局根（含 editor/bottomBar，关闭设置视图时恢复） */
  layoutRoot: Component;
  /** 关闭设置视图后要恢复焦点的组件（Editor） */
  focusTarget: Component;
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

const BUILD_NUMERIC_KEYS = new Set([
  "build.batchSize",
  "build.retries",
  "build.perChapterOutputTokens",
  "build.maxBatchChapters",
]);
const BUILD_BOOL_KEYS = new Set(["build.autoBatch", "build.agentExtract", "build.sessionLog"]);

/** 把 /settings 里用户输入写进 cfg（userChapter 即时生效；LLM 连接不走这里，归 /login） */
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
  if (BUILD_NUMERIC_KEYS.has(id)) {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return false;
    setPath(cfg as unknown as Record<string, unknown>, id, n);
    saveConfig(cfg);
    return true;
  }
  if (BUILD_BOOL_KEYS.has(id)) {
    setPath(cfg as unknown as Record<string, unknown>, id, raw === "true");
    saveConfig(cfg);
    return true;
  }
  return false;
}

/** userChapter 变更的即时副作用（对齐 /chapter 切换的行为） */
function applyUserChapter(deps: MenuDeps, n: number): void {
  deps.repo.setUserChapter(n);
  if (deps.toolCtx) deps.toolCtx.userChapter = n;
  if (deps.focus && deps.focus.to !== null && deps.focus.to > n) {
    deps.focus.from = null;
    deps.focus.to = null;
  }
  if (deps.agent) deps.agent.reset(); // 清 Agent 历史，防旧数据经对话上下文泄露
}

/** 预填 Input 并把光标移到末尾（输入自然追加；Input 无公开 cursor API） */
function prefillInput(input: Input, value: string): void {
  input.setValue(value);
  (input as unknown as { cursor: number }).cursor = value.length;
}

/** 子菜单：单行文本编辑（Enter 保存 · Esc 取消；数字项校验）
 * 注意：pi-tui 的 Container 不转发 handleInput，SettingsList 会把子菜单输入委托给
 * submenuComponent.handleInput —— 所以这里必须自定义组件并把输入转发给 Input，
 * 同时手动置 Input.focused=true 让其渲染硬件光标（IME 候选框定位）。 */
function textFieldSubmenu(title: string, current: string, type: "string" | "number", done: (v: string | undefined) => void): Component {
  const input = new Input();
  prefillInput(input, current);
  input.focused = true;
  const error = new Text("", 0, 0);
  input.onSubmit = (v) => {
    const t = v.trim();
    if (type === "number" && t !== "" && !Number.isFinite(Number(t))) {
      error.setText(red(`  请输入有效数字`));
      return;
    }
    done(t);
  };
  input.onEscape = () => done(undefined);
  return {
    render(width: number): string[] {
      return [dim(`  ${title}`), "", ...input.render(width), "", ...error.render(width)];
    },
    handleInput(data: string): void {
      input.handleInput(data);
    },
    invalidate(): void {
      input.invalidate();
      error.invalidate();
    },
  };
}

// ── /settings ─────────────────────────────────────

/** /settings 只放通用配置（reader/build）；LLM 连接参数归 /login、凭据清除归 /logout */
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
    field("build.batchSize", "build · batchSize", "number", String(cfg.build?.batchSize ?? 1), "固定模式每批章节数"),
    field("build.retries", "build · retries", "number", String(cfg.build?.retries ?? 2), "批内失败重试次数"),
    cycle("build.autoBatch", "build · autoBatch", String(cfg.build?.autoBatch ?? false), ["true", "false"], "按上下文自动合并批次"),
    field("build.perChapterOutputTokens", "build · perChapterOutputTokens", "number", String(cfg.build?.perChapterOutputTokens ?? 260), "每章结构化输出的 token 估算（输出预算）"),
    field("build.maxBatchChapters", "build · maxBatchChapters", "number", String(cfg.build?.maxBatchChapters ?? 60), "单批章节数上限"),
    cycle("build.agentExtract", "build · agentExtract", String(cfg.build?.agentExtract ?? true), ["true", "false"], "Agent 化抽取（false 回退注入实体清单）"),
    cycle("build.sessionLog", "build · sessionLog", String(cfg.build?.sessionLog ?? true), ["true", "false"], "构建会话日志落盘 .story/logs/build/"),
  ];
}

// ── 局部视图切换（/settings /login：只把输入区换面板，顶栏 + 聊天区保留） ──

function asViewport(tui: TUI): ViewportTUI {
  return tui as unknown as ViewportTUI; // app.ts 只传 TuiAltScreen（viewport TUI）
}

/**
 * 用「顶栏 + 聊天区 + 面板」重建布局根：editor/bottomBar 那块被面板替换，
 * 顶栏和聊天历史仍可见（对齐 pi：不是整屏都变 settings/login）。
 */
function showModalView(tui: TUI, deps: MenuDeps, panel: Component, focus: Component): void {
  const view = new VStack([
    { component: deps.topBar, basis: "auto", grow: 0, shrink: 0 },
    { component: deps.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: panel, basis: 0, grow: 1, shrink: 1, minSize: 3 },
  ]);
  asViewport(tui).setLayoutRoot(view);
  tui.setFocus(focus);
  tui.requestRender();
}

function closeModalView(tui: TUI, deps: MenuDeps): void {
  asViewport(tui).setLayoutRoot(deps.layoutRoot);
  tui.setFocus(deps.focusTarget);
  tui.requestRender();
}

/** /settings：把输入区替换为设置菜单面板（Enter/Space 修改 · / 搜索 · Esc 返回） */
export function openSettingsView(tui: TUI, deps: MenuDeps): void {
  const items = buildSettingsItems(deps);
  const list = new SettingsList(
    items,
    15,
    settingsTheme,
    (id, raw) => {
      const ok = applyChange(deps, id, raw);
      if (!ok) {
        const orig = items.find((i) => i.id === id)?.currentValue;
        if (orig !== undefined) list.updateValue(id, orig); // 非法输入恢复显示
      }
      tui.requestRender();
    },
    () => closeModalView(tui, deps),
    { enableSearch: true }
  );
  showModalView(tui, deps, list, list);
}

// ── /login ────────────────────────────────────────

type WizardRow = { key: string; label: string; value: string; action?: boolean; cycle?: boolean };

/**
 * /login：引导式 LLM 连接向导（对齐 pi code agent 的 /login 交互模式）。
 * 步骤：baseUrl → apiKey → model → thinkingFormat → 测试连接 → 保存并完成；Esc 取消。
 * 保存只写 .story/config.json 的 llm.*，环境变量优先语义不变。
 */
class LoginWizard implements Component {
  private sel = 0;
  private status = "";
  private busy = false;
  private editing: { input: Input } | null = null;
  private vals = { baseUrl: "", apiKey: "", model: "", thinking: "auto" };

  constructor(
    private deps: MenuDeps,
    private onClose: () => void,
    private onSaved: (summary: string) => void,
    private requestRender: () => void
  ) {
    this.vals.baseUrl = deps.cfg.llm?.baseUrl ?? "";
    this.vals.apiKey = deps.cfg.llm?.apiKey ?? "";
    this.vals.model = deps.cfg.llm?.model ?? "";
    this.vals.thinking = deps.cfg.llm?.thinkingFormat ?? "auto";
  }

  private rows(): WizardRow[] {
    return [
      { key: "baseUrl", label: "baseUrl", value: this.vals.baseUrl || dim("（留空用环境变量）") },
      { key: "apiKey", label: "apiKey", value: this.vals.apiKey ? yellow(maskSecret(this.vals.apiKey)) : dim("（未设置）") },
      { key: "model", label: "model", value: this.vals.model || dim("（留空用环境变量）") },
      { key: "thinking", label: "thinkingFormat", value: this.vals.thinking, cycle: true },
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
      else if (row.key === "save") void this.save();
      return;
    }
    if (row.key === "thinking") {
      // 循环切换推理协议（glm 系选 zai、deepseek 系选 deepseek，auto 自动识别）
      const opts = ["auto", "deepseek", "zai", "qwen", "openrouter", "openai"];
      const i = opts.indexOf(this.vals.thinking);
      this.vals.thinking = opts[(i + 1) % opts.length];
      this.requestRender();
      return;
    }
    const input = new Input();
    const key = row.key as "baseUrl" | "apiKey" | "model";
    prefillInput(input, key === "apiKey" ? "" : this.vals[key]);
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
        thinkingFormat: this.vals.thinking === "auto" ? undefined : (this.vals.thinking as NonNullable<StoryConfig["llm"]>["thinkingFormat"]),
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

  private async save(): Promise<void> {
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
    if (this.vals.thinking && this.vals.thinking !== "auto") {
      llm.thinkingFormat = this.vals.thinking as NonNullable<StoryConfig["llm"]>["thinkingFormat"];
    } else {
      delete llm.thinkingFormat;
    }
    this.deps.cfg.llm = llm;
    saveConfig(this.deps.cfg);
    // 重建 provider/agent：LLM 配置实时生效（无需重启）
    let reloadNote = "> LLM/构建配置已写入 `.story/config.json`，退出并重新运行 `npm run dev` 后生效。";
    if (this.deps.onLlmChanged) {
      const r = await this.deps.onLlmChanged();
      reloadNote = r.ok
        ? (r.mode === "llm"
          ? "> ✅ 已实时生效（provider/agent 已重建，无需重启）。"
          : "> ⚠️ 已实时生效，但连接信息不完整，当前为 mock（离线）模式；补全后再试 /login。")
        : `> ❌ 已保存但重建 LLM 失败：${r.error ?? "未知错误"}（下次启动时按新配置生效）。`;
    }
    const summary = [
      "## 登录完成",
      `- \`baseUrl\` = \`${llm.baseUrl ?? "（未设置）"}\``,
      `- \`apiKey\` = \`${llm.apiKey ? maskSecret(llm.apiKey) : "（未设置）"}\``,
      `- \`model\` = \`${llm.model ?? "（未设置）"}\``,
      `- \`thinkingFormat\` = \`${llm.thinkingFormat ?? "auto（自动识别）"}\``,
      reloadNote,
    ].join("\n");
    this.onSaved(summary);
    this.onClose();
  }
}

/** /login：把输入区替换为 LLM 连接向导面板（填写 → 测试 → 保存，Esc 返回） */
export function openLoginView(tui: TUI, deps: MenuDeps): void {
  const wizard = new LoginWizard(
    deps,
    () => closeModalView(tui, deps),
    (summary) => deps.onNotify?.(summary),
    () => tui.requestRender()
  );
  showModalView(tui, deps, wizard, wizard);
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

// ── /build 构建面板 ───────────────────────────────

const panelMdTheme: MarkdownTheme = {
  heading: (t) => `\x1b[1;36m${t}\x1b[0m`,
  link: (t) => `\x1b[4;34m${t}\x1b[0m`,
  linkUrl: (t) => `\x1b[2;34m${t}\x1b[0m`,
  code: (t) => `\x1b[33m${t}\x1b[0m`,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => `\x1b[2m${t}\x1b[0m`,
  quote: (t) => `\x1b[2;3m${t}\x1b[0m`,
  quoteBorder: (t) => `\x1b[2m${t}\x1b[0m`,
  hr: (t) => `\x1b[2m${t}\x1b[0m`,
  listBullet: (t) => `\x1b[36m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
  italic: (t) => `\x1b[3m${t}\x1b[0m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[0m`,
  underline: (t) => `\x1b[4m${t}\x1b[0m`,
};

/** 构建面板控制器（commands.ts 的 /build 用它喂进度/汇总） */
export interface BuildPanelHandle {
  /** 更新面板内容（markdown：进度 / 汇总） */
  render(text: string): void;
  /** 构建结束：Esc 从「取消」切换为「返回」 */
  markDone(): void;
  /** 把焦点还给面板（onSubmit 末尾会抢回 editor，需在命令返回后延迟调用） */
  focus(): void;
  /** 面板当前宽度（列数；供进度条自适应窗口大小；未渲染时返回 0） */
  width(): number;
}

/**
 * /build 面板：把输入区替换为构建面板，进度实时渲染；构建中 Esc=取消，完成后 Esc=返回。
 * 期间输入框被替换，无法干别的（不能打字提问/发其它命令）。
 */
class BuildPanel implements Component {
  private md = new Markdown("", 1, 0, panelMdTheme);
  private done = false;
  private lastWidth = 0;

  constructor(
    private requestRender: () => void,
    private onCancel: () => void,
    private onClose: () => void
  ) {}

  setText(t: string): void {
    this.md.setText(t);
    this.requestRender();
  }

  markDone(): void {
    this.done = true;
    this.requestRender();
  }

  width(): number {
    return this.lastWidth;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const body = this.md.render(width);
    return [...body, "", dim(this.done ? "Esc 返回" : "构建中… Esc 取消")];
  }

  invalidate(): void {
    this.md.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      if (this.done) this.onClose();
      else this.onCancel();
    }
  }
}

/** /build：打开构建面板并返回控制器（构建本身由调用方执行，经 render/markDone 喂给面板） */
export function openBuildView(tui: TUI, deps: MenuDeps, hooks: { onCancel: () => void }): BuildPanelHandle {
  const panel = new BuildPanel(
    () => tui.requestRender(),
    hooks.onCancel,
    () => closeModalView(tui, deps)
  );
  showModalView(tui, deps, panel, panel);
  return {
    render: (text) => panel.setText(text),
    markDone: () => panel.markDone(),
    focus: () => {
      tui.setFocus(panel);
      tui.requestRender();
    },
    width: () => panel.width() || Math.max(20, tui.terminal.columns - 2),
  };
}
