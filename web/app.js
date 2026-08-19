"use strict";

// StoryPack 小说百科 SPA（零框架）。
// 全部数据经服务端 /api/* 获取，防剧透过滤发生在服务端数据访问层（setUserChapter）；
// 前端只负责把「第 N 章之前的知识」渲染成页面。

const $ = (sel) => document.querySelector(sel);

const S = {
  book: "",
  availableThrough: null,
  builtThrough: null,
  defaultChapter: 1,
  chapter: 1,
  protagonist: null,
  counts: null,
};

const TYPE_LABEL = { character: "角色", organization: "组织", location: "地点", item: "物品", concept: "概念" };
const FACT_LABEL = {
  identity: "身份",
  role: "身份",
  occupation: "职业",
  affiliation: "所属",
  status: "状态",
  appearance: "外貌",
  personality: "性格",
  name_origin: "名字由来",
  background: "背景",
  goal: "目标",
};

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const chQS = () => `?chapter=${S.chapter}`;

function badge(type, label) {
  return `<span class="badge ${esc(type)}">${esc(label || TYPE_LABEL[type] || type)}</span>`;
}

function entityLink(name, text) {
  return `<a href="#/entity/${encodeURIComponent(name)}">${esc(text ?? name)}</a>`;
}

function errPage(e) {
  return `<div class="page-error">⚠️ ${esc(e instanceof Error ? e.message : String(e))}</div>`;
}

// ---------- 路由 ----------

async function render() {
  const app = $("#app");
  const hash = location.hash || "#/";
  try {
    if (hash.startsWith("#/entity/")) {
      const name = decodeURIComponent(hash.slice(hash.indexOf("/entity/") + 8));
      await renderEntity(app, name);
    } else if (hash.startsWith("#/search")) {
      const q = new URLSearchParams(hash.split("?")[1] || "").get("q") || "";
      await renderSearch(app, q);
    } else {
      await renderHome(app);
    }
  } catch (e) {
    app.innerHTML = errPage(e);
  }
}

let debounceTimer = null;
function scheduleRender() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(render, 250);
}

// ---------- 首页 ----------

async function renderHome(app) {
  const data = await api(`/api/index${chQS()}`);
  const totalVisible = data.groups.reduce((sum, g) => sum + g.entities.length, 0);
  const isBuilt = S.builtThrough && S.builtThrough >= 1;

  let hero = `
    <section class="hero">
      <h1>${esc(S.book)}</h1>
      <div class="sub">这部小说的结构化知识百科 —— 一切内容随你的阅读进度展开。</div>
      <div class="chips">
        <span class="chip">📚 已导入 <b>${S.availableThrough ?? 0}</b> 章</span>
        <span class="chip">🧠 已构建 <b>${isBuilt ? S.builtThrough : 0}</b> 章</span>
        <span class="chip">👀 当前读到 <b>第 ${S.chapter} 章</b></span>
        <span class="chip">🗂️ 可见实体 <b>${totalVisible}</b> 个</span>
      </div>
      <div class="spoiler-note">
        🔒 防剧透模式：本页只显示你<b>已经读到</b>（第 ${S.chapter} 章之前）的内容；
        还未出场的角色、尚未发生的事件，在这里「不存在」。拖动顶部进度条即可模拟读到更后面。
      </div>
      ${
        S.protagonist
          ? `<a class="prototype-card" href="#/entity/${encodeURIComponent(S.protagonist.name)}">
               <span class="star">⭐</span>
               <span>
                 <span class="who">${esc(S.protagonist.name)}</span>
                 <div class="meta">主角 · 第 ${S.protagonist.first_seen_chapter} 章登场 · 出场章节最多的角色 →</div>
               </span>
             </a>`
          : ""
      }
    </section>`;

  let groupsHTML = "";
  for (const g of data.groups) {
    if (!g.entities.length) continue;
    groupsHTML += `
      <div class="group-section">
        <div class="section-title">
          <span style="color:var(--${esc(g.type)})">${esc(g.label)}</span>
          <span class="count">${g.count} 个</span>
          ${g.type === "character" ? '<span class="note">点击卡片查看完整档案</span>' : ""}
        </div>
        <div class="entity-grid">
          ${g.entities.map(entityCardHTML(g.type)).join("")}
        </div>
      </div>`;
  }

  if (!groupsHTML) {
    groupsHTML = `<div class="page-error">
      📭 在「第 ${S.chapter} 章之前」还没有任何实体。
      ${isBuilt ? "把顶部进度条往后拉（已构建到第 " + S.builtThrough + " 章），或先用 <code>story build</code> 构建更多章节。" : "该项目还没有构建结构化数据，请先运行 <code>story build</code>。"}
    </div>`;
  }

  app.innerHTML = hero + groupsHTML;
}

function entityCardHTML(type) {
  return (e) => {
    const whereParts = [`第 ${e.first_seen_chapter} 章登场`];
    if (e.last_seen_chapter && e.last_seen_chapter !== e.first_seen_chapter) {
      whereParts.push(`活跃至第 ${e.last_seen_chapter} 章`);
    }
    if (e.aliases.length) whereParts.push(`别称「${esc(e.aliases[0])}${e.aliases.length > 1 ? " 等" : ""}」`);
    return `
      <a class="entity-card" style="--type-color: var(--${esc(type)})" href="#/entity/${encodeURIComponent(e.name)}">
        <div class="name">${esc(e.name)}${badge(type)}</div>
        ${e.tagline ? `<div class="tagline">${esc(e.tagline)}</div>` : ""}
        <div class="where">${whereParts.join(" · ")}</div>
      </a>`;
  };
}

// ---------- 实体详情 ----------

async function renderEntity(app, name) {
  const data = await api(`/api/entity${chQS()}&name=${encodeURIComponent(name)}`);
  const e = data.entity;

  const factGroups = groupFacts(data.facts);
  const factsHTML = factGroups.length
    ? factGroups
        .map(
          (g) => `
        <div class="fact-group">
          <h4>${esc(g.label)}</h4>
          ${g.items
            .map(
              (f) => `
            <div class="fact-item">${esc(f.value)}<span class="src">第 ${f.chapter} 章 · 可信度 ${Math.round(f.confidence * 100)}%</span></div>`
            )
            .join("")}
        </div>`
        )
        .join("")
    : `<div class="empty">暂无身份/经历记录 —— 这个进度下还没有关于「${esc(e.name)}」的事实。</div>`;

  const abilitiesHTML = data.abilities.length
    ? data.abilities
        .map(
          (a) => `
        <div class="ability-item">
          <div class="nm">${esc(a.name)}
            ${a.level ? `<span class="tag">${esc(a.level)}</span>` : ""}
            ${a.acquired_chapter ? `<span class="tag">掌握于第 ${a.acquired_chapter} 章</span>` : ""}
          </div>
          ${a.system || a.category || a.path ? `<div class="tags">${[a.system, a.category, a.path].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
          ${a.summary ? `<div class="sum">${esc(a.summary)}</div>` : ""}
        </div>`
        )
        .join("")
    : `<div class="empty">暂无能力记录。</div>`;

  const relationsHTML = data.relations.length
    ? data.relations
        .map((r) => {
          const other = entityLink(r.other.name);
          const line =
            r.direction === "out"
              ? `${esc(e.name)} <span class="arrow">—${esc(r.type)}→</span> ${other}`
              : `${other} <span class="arrow">—${esc(r.type)}→</span> ${esc(e.name)}`;
          return `
          <div class="rel-item">
            <span>${line}</span>
            ${r.detail ? `<span class="rdetail">${esc(r.detail)}</span>` : ""}
            <span class="rmeta">第 ${r.chapter} 章</span>
          </div>`;
        })
        .join("")
    : `<div class="empty">暂无关系记录。</div>`;

  const anchorsHTML = timelineHTML(
    data.anchors.slice(0, 120).map((a) => ({
      chapter: a.chapter,
      main: esc(a.summary),
      extra: `记忆度 ${Math.round(a.memorability * 100)}% · 重要度 ★${a.importance.toFixed(1)}`,
      cls: "anchor",
    })),
    data.anchors.length > 120 ? `＋${data.anchors.length - 120} 条更多…` : null,
    "暂无高光记忆锚点。"
  );

  const eventsHTML = timelineHTML(
    data.events.slice(0, 120).map((ev) => ({
      chapter: ev.chapter,
      main: esc(ev.summary),
      extra: `${esc(ev.type)}${ev.participants.length ? " · " + ev.participants.map((p) => esc(p)).join("、") : ""}`,
      cls: "",
    })),
    data.events.length > 120 ? `＋${data.events.length - 120} 条更多…` : null,
    "暂无事件记录。"
  );

  const barsHTML = appearancesChart(data);

  app.innerHTML = `
    <nav class="crumbs"><a href="#/">◂ 浏览全书</a> <span>/</span> <span class="cur">${esc(e.name)}</span></nav>

    <section class="profile-head">
      <h1>${esc(e.name)} ${badge(e.type)}</h1>
      ${data.aliases.length ? `<div class="aliases">${data.aliases.map((a) => `<span class="alias-chip">${esc(a)}</span>`).join("")}</div>` : ""}
      <div class="meta-chips">
        <span class="chip">📅 第 ${e.first_seen_chapter} 章登场</span>
        ${e.last_seen_chapter && e.last_seen_chapter !== e.first_seen_chapter ? `<span class="chip">👋 活跃至第 ${e.last_seen_chapter} 章</span>` : ""}
        <span class="chip">🎭 出场 ${data.appearanceStats.count || 0} 章</span>
        ${data.resolvedAs === "alias" ? `<span class="chip">🔎 通过别称查找到</span>` : ""}
      </div>
    </section>

    <div class="section-title">档案 <span class="count">facts · ${data.facts.length} 条</span></div>
    <div class="panel">${factsHTML}</div>

    <div class="two-col">
      <section>
        <div class="section-title">能力 <span class="count">${data.abilities.length} 项</span></div>
        <div class="panel">${abilitiesHTML}</div>
      </section>
      <section>
        <div class="section-title">关系 <span class="count">${data.relations.length} 条</span></div>
        <div class="panel">${relationsHTML}</div>
      </section>
    </div>

    <div class="two-col">
      <section>
        <div class="section-title">高光时刻 <span class="count">记忆锚点 · ${data.anchors.length}</span></div>
        <div class="panel"><div class="timeline">${anchorsHTML}</div></div>
      </section>
      <section>
        <div class="section-title">相关事件 <span class="count">${data.events.length} 起</span></div>
        <div class="panel"><div class="timeline">${eventsHTML}</div></div>
      </section>
    </div>

    <div class="section-title">出场分布 <span class="count">${data.appearances.length} 章有提及</span></div>
    <div class="panel">${barsHTML}</div>`;
}

function groupFacts(facts) {
  const order = ["identity", "occupation", "affiliation", "status", "appearance", "personality", "background", "goal"];
  const groups = [];
  const byType = new Map();
  for (const f of facts) {
    const t = f.type || "其他";
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(f);
  }
  const types = [...order.filter((t) => byType.has(t)), ...[...byType.keys()].filter((t) => !order.includes(t))];
  for (const t of types.slice(0, 12)) {
    groups.push({ label: FACT_LABEL[t] || t, items: byType.get(t) });
  }
  return groups;
}

function timelineHTML(entries, overflowNote, emptyText) {
  if (!entries.length) return `<div class="empty">${emptyText}</div>`;
  return (
    entries
      .map(
        (t) => `
      <div class="tl-item ${t.cls}">
        <span class="tl-ch">第 ${t.chapter} 章</span>
        <div class="tl-sum">${t.main}</div>
        ${t.extra ? `<div class="tl-extra">${t.extra}</div>` : ""}
      </div>`
      )
      .join("") + (overflowNote ? `<div class="empty">${overflowNote}</div>` : "")
  );
}

function appearancesChart(data) {
  const list = data.appearances || [];
  if (!list.length) return `<div class="empty">这个进度下没有出场记录。</div>`;
  const maxMentions = Math.max(...list.map((a) => a.mentions), 1);
  const bars = list
    .map(
      (a) =>
        `<span class="bar" style="height:${Math.max(3, Math.round((a.mentions / maxMentions) * 52))}px" title="第 ${a.chapter} 章 · 提及 ${a.mentions} 次"></span>`
    )
    .join("");
  return `
    <div class="appearance-bars">${bars}</div>
    <div class="appearance-labels">
      <span>第 ${list[0].chapter} 章</span>
      <span>${list.length} 章有提及 · 峰值 ${maxMentions} 次</span>
      <span>第 ${list[list.length - 1].chapter} 章</span>
    </div>`;
}

// ---------- 搜索 ----------

async function renderSearch(app, q) {
  const data = await api(`/api/search${chQS()}&q=${encodeURIComponent(q)}&topK=24`);
  const hits = data.hits || [];
  app.innerHTML = `
    <div class="section-title">搜索「<span style="color:var(--accent)">${esc(q)}</span>」 <span class="count">${hits.length} 个结果（截至第 ${S.chapter} 章）</span></div>
    ${
      hits.length
        ? hits
            .map(
              (h) => `
          <div class="search-hit">
            <div>
              <a class="name" href="#/entity/${encodeURIComponent(h.entity.name)}">${esc(h.entity.name)}</a> ${badge(h.entity.type)}
              <div class="via">匹配：${esc(h.matchedVia || "名称")}</div>
            </div>
            <div class="scorebar"><i style="width:${Math.min(100, Math.round(h.score))}%"></i></div>
            <span class="score">${Math.round(h.score)} 分</span>
          </div>`
            )
            .join("")
        : `<div class="page-error">没有找到与「${esc(q)}」相关的实体。可能它尚未在"第 ${S.chapter} 章之前"出现、还未被构建，或换个说法再搜。拖动顶部进度条试试。</div>`
    }`;
}

// ---------- 启动 ----------

async function init() {
  try {
    const st = await api("/api/state");
    S.book = st.book || "未命名小说";
    S.availableThrough = st.availableThrough;
    S.builtThrough = st.builtThrough;
    S.defaultChapter = st.defaultChapter || 1;
    S.protagonist = st.protagonist || null;
    S.counts = st.counts || null;

    document.title = `${S.book} · StoryPack 百科`;
    $("#book-title").textContent = S.book;

    const slider = $("#chapter-slider");
    const max = Math.max(1, S.builtThrough || S.availableThrough || 1);
    slider.min = 1;
    slider.max = max;
    slider.value = 1;

    const saved = Number.parseInt(localStorage.getItem("storypack.chapter") || "", 10);
    let chapter = Number.isFinite(saved) && saved >= 1 ? saved : S.defaultChapter;
    chapter = Math.max(1, Math.min(chapter, max));
    S.chapter = chapter;
    slider.value = chapter;
    $("#chapter-label").textContent = chapter;
    $("#progress-max").textContent = S.builtThrough ? `/ 已构建 ${S.builtThrough} 章` : "（未构建）";

    slider.addEventListener("input", () => {
      const n = Number.parseInt(slider.value, 10);
      S.chapter = n;
      $("#chapter-label").textContent = n;
      localStorage.setItem("storypack.chapter", String(n));
      scheduleRender();
    });

    $("#search-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const q = $("#search-input").value.trim();
      if (q) location.hash = "#/search?q=" + encodeURIComponent(q);
    });

    $("#foot").innerHTML = `
      StoryPack ·《${esc(S.book)}》· 内容来自 <code>story build</code> 的结构化知识，不含小说正文<br/>
      🔒 防剧透边界：第 ${S.chapter} 章（可在顶部调整）· 数据截至本节 · 搜索为模糊匹配（名称/别名/身份/事件）`;

    window.addEventListener("hashchange", render);
    render();
  } catch (e) {
    $("#app").innerHTML = errPage(e);
  }
}

init();