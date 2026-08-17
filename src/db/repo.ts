// 数据访问层：对 SQLite 的封装。Ask 阶段只允许通过本层访问【结构化表】，
// 绝不暴露 chapters 表读取（chapters 原始文本仅供 Build 使用）。

import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, verifySchemaMax } from "./schema.js";
import { entityId } from "../util.js";

export type EntityType = "character" | "organization" | "location" | "item" | "concept";
export const ENTITY_TYPES: EntityType[] = ["character", "organization", "location", "item", "concept"];

export interface EntityRow {
  id: string;
  type: EntityType;
  name: string;
  first_seen_chapter: number;
  last_seen_chapter: number | null;
  description: string | null;
}

export interface AliasRow {
  id: number;
  entity_id: string;
  alias: string;
  from_chapter: number;
  note: string | null;
}

export interface FactRow {
  id: number;
  entity_id: string;
  type: string;
  value: string;
  chapter: number;
  confidence: number;
  status: string;
}

export interface RelationRow {
  id: number;
  from_entity_id: string;
  to_entity_id: string;
  type: string;
  detail: string | null;
  chapter: number;
  confidence: number;
  status: string;
}

export interface AbilityRow {
  id: number;
  entity_id: string;
  name: string;
  category: string | null;
  system: string | null;
  path: string | null;
  level: string | null;
  source_entity: string | null;
  acquired_chapter: number | null;
  summary: string | null;
  chapter: number;
  confidence: number;
}

export interface EventRow {
  id: number;
  chapter: number;
  participants: string;
  type: string;
  summary: string;
  importance: number;
  status: string;
}

export interface MemoryAnchorRow {
  id: number;
  entity_id: string;
  chapter: number;
  summary: string;
  importance: number;
  memorability: number;
  protagonist_relevance: number;
  status: string;
}

export interface DuplicateRow {
  id: number;
  entity_a: string;
  entity_b: string;
  reason: string | null;
  status: string;
  note: string | null;
}

export interface ConflictRow {
  id: number;
  kind: string;
  entity_id: string | null;
  detail: string;
  chapter_a: number | null;
  chapter_b: number | null;
  status: string;
}

export interface ChapterRow {
  chapter: number;
  title: string;
  chars: number;
}

// node:sqlite 的 .all()/.get() 返回 SQLOutputValue，这里统一做显式转型
type Rows<T> = T[];
function rows<T>(r: unknown[]): Rows<T> {
  return r as unknown as Rows<T>;
}

export class StoryRepo {
  readonly db: DatabaseSync;
  readonly maxChapter: number;
  /** 用户当前阅读进度边界（Ask 过滤用）。默认 = maxChapter（全量）。
   *  Ask/Agent 路径通过 setUserChapter() 收窄，使所有读方法只返回 chapter <= userChapter 的数据。 */
  private userChapterBound: number;

  constructor(dbPath: string, maxChapter: number) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.maxChapter = maxChapter;
    this.userChapterBound = maxChapter;
    this.db.exec(SCHEMA_SQL({ maxChapter, book: "" }));
    verifySchemaMax(this.db, maxChapter);
  }

  /** 设置 Ask 阅读进度边界（1..maxChapter）。之后所有读方法只返回 chapter <= userChapter 的数据。 */
  setUserChapter(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > this.maxChapter) {
      throw new Error(`userChapter ${n} 非法（必须在 1..${this.maxChapter}）`);
    }
    this.userChapterBound = n;
  }
  get userChapter(): number {
    return this.userChapterBound;
  }
  /** chapter 过滤子句；若边界未收窄（=maxChapter）返回空串（保持 SQL 简单） */
  private chFilter(col: string): string {
    return this.userChapterBound < this.maxChapter ? ` AND ${col} <= ${this.userChapterBound}` : "";
  }

  // ---------- meta ----------
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  installedBook(): string | null {
    return this.getMeta("book");
  }

  // ---------- chapters（仅 Build/Import 使用；Ask 层禁止调用） ----------
  replaceChapters(chapters: { number: number; title: string; text: string }[]): void {
    const del = this.db.prepare("DELETE FROM chapters");
    const ins = this.db.prepare("INSERT OR REPLACE INTO chapters(chapter,title,text,chars) VALUES(?,?,?,?)");
    this.db.exec("BEGIN");
    try {
      del.run();
      for (const c of chapters) {
        if (c.number < 1 || c.number > this.maxChapter) {
          throw new Error(`非法章节号 ${c.number}（maxChapter=${this.maxChapter}），拒绝入库`);
        }
        ins.run(c.number, c.title, c.text, Buffer.byteLength(c.text, "utf-8"));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  listChapterMeta(): ChapterRow[] {
    return rows<ChapterRow>(this.db.prepare(`SELECT chapter, title, chars FROM chapters WHERE chapter >= 1${this.chFilter("chapter")} ORDER BY chapter`).all());
  }
  countChapters(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM chapters").get() as { n: number };
    return r.n;
  }
  getChapterText(number: number): string | null {
    const r = this.db.prepare("SELECT text FROM chapters WHERE chapter=?").get(number) as { text: string } | undefined;
    return r ? r.text : null;
  }
  maxChapterInDb(): number | null {
    const r = this.db.prepare("SELECT MAX(chapter) AS m FROM chapters").get() as { m: number | null };
    return r.m;
  }

  // ---------- entities ----------
  findEntityByTypeName(type: EntityType, name: string): EntityRow | null {
    const r = this.db.prepare("SELECT * FROM entities WHERE type=? AND name=?").get(type, name) as EntityRow | undefined;
    return r ?? null;
  }
  getEntity(id: string): EntityRow | null {
    const r = this.db.prepare("SELECT * FROM entities WHERE id=?").get(id) as EntityRow | undefined;
    return r ?? null;
  }
  /** 通过 id 或精确名称解析实体 */
  resolveEntity(ref: string): EntityRow | null {
    return this.getEntity(ref) ?? this.findEntityByName(ref);
  }
  findEntityByName(name: string): EntityRow | null {
    const r = this.db.prepare("SELECT * FROM entities WHERE name=?").get(name) as EntityRow | undefined;
    return r ?? null;
  }
  listEntities(type?: EntityType): EntityRow[] {
    const f = this.chFilter("first_seen_chapter");
    if (type) return rows<EntityRow>(this.db.prepare(`SELECT * FROM entities WHERE type=?${f} ORDER BY first_seen_chapter`).all(type));
    return rows<EntityRow>(this.db.prepare(`SELECT * FROM entities WHERE 1=1${f} ORDER BY first_seen_chapter`).all());
  }
  upsertEntity(type: EntityType, name: string, chapter: number): { id: string; created: boolean } {
    if (chapter < 1 || chapter > this.maxChapter) {
      throw new Error(`实体 ${name} 的章节 ${chapter} 超出 maxChapter=${this.maxChapter}`);
    }
    const existing = this.findEntityByTypeName(type, name);
    if (existing) {
      this.db
        .prepare(
          "UPDATE entities SET first_seen_chapter=MIN(first_seen_chapter, ?), last_seen_chapter=MAX(COALESCE(last_seen_chapter,0), ?) WHERE id=?"
        )
        .run(chapter, chapter, existing.id);
      return { id: existing.id, created: false };
    }
    const id = entityId(type, name);
    this.db
      .prepare("INSERT INTO entities(id,type,name,first_seen_chapter,last_seen_chapter) VALUES(?,?,?,?,?)")
      .run(id, type, name, chapter, chapter);
    return { id, created: true };
  }
  renameEntity(id: string, newName: string): void {
    this.db.prepare("UPDATE entities SET name=? WHERE id=?").run(newName, id);
  }

  // ---------- aliases ----------
  addAlias(entityIdRef: string, alias: string, chapter: number, note?: string): "added" | "exists" | "clash" {
    const e = this.getEntity(entityIdRef);
    if (!e) throw new Error(`别名指向不存在的实体: ${entityIdRef}`);
    // 别名与其他实体冲突？
    const other = this.findByAlias(alias);
    if (other && other.id !== entityIdRef) return "clash";
    const r = this.db.prepare("INSERT OR IGNORE INTO aliases(entity_id,alias,from_chapter,note) VALUES(?,?,?,?)").run(entityIdRef, alias, chapter, note ?? null);
    return r.changes > 0 ? "added" : "exists";
  }
  findByAlias(alias: string): EntityRow | null {
    const r = this.db
      .prepare("SELECT e.* FROM aliases a JOIN entities e ON e.id=a.entity_id WHERE a.alias=?")
      .get(alias) as EntityRow | undefined;
    return r ?? null;
  }
  listAliases(entityIdRef?: string): AliasRow[] {
    const f = this.chFilter("from_chapter");
    if (entityIdRef) {
      return rows<AliasRow>(this.db.prepare(`SELECT * FROM aliases WHERE entity_id=?${f} ORDER BY from_chapter`).all(entityIdRef));
    }
    return rows<AliasRow>(this.db.prepare(`SELECT * FROM aliases WHERE 1=1${f} ORDER BY id`).all());
  }

  // ---------- facts ----------
  addFact(entityIdRef: string, type: string, value: string, chapter: number, confidence: number): boolean {
    this.assertChapter(chapter);
    const r = this.db
      .prepare("INSERT OR IGNORE INTO facts(entity_id,type,value,chapter,confidence) VALUES(?,?,?,?,?)")
      .run(entityIdRef, type, value, chapter, confidence);
    return r.changes > 0;
  }
  listFacts(entityIdRef?: string): FactRow[] {
    const f = this.chFilter("chapter");
    if (entityIdRef) return rows<FactRow>(this.db.prepare(`SELECT * FROM facts WHERE entity_id=?${f} ORDER BY chapter`).all(entityIdRef));
    return rows<FactRow>(this.db.prepare(`SELECT * FROM facts WHERE 1=1${f} ORDER BY id`).all());
  }
  countFacts(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM facts").get() as { n: number }).n;
  }

  // ---------- relations ----------
  addRelation(fromId: string, toId: string, type: string, detail: string | null, chapter: number, confidence: number): boolean {
    this.assertChapter(chapter);
    const r = this.db
      .prepare("INSERT OR IGNORE INTO relations(from_entity_id,to_entity_id,type,detail,chapter,confidence) VALUES(?,?,?,?,?,?)")
      .run(fromId, toId, type, detail ?? null, chapter, confidence);
    return r.changes > 0;
  }
  listRelations(entityIdRef?: string): RelationRow[] {
    const f = this.chFilter("chapter");
    if (entityIdRef) {
      return rows<RelationRow>(
        this.db.prepare(`SELECT * FROM relations WHERE (from_entity_id=? OR to_entity_id=?)${f} ORDER BY chapter`).all(entityIdRef, entityIdRef)
      );
    }
    return rows<RelationRow>(this.db.prepare(`SELECT * FROM relations WHERE 1=1${f} ORDER BY id`).all());
  }

  // ---------- abilities ----------
  addAbility(
    entityIdRef: string,
    row: {
      name: string;
      category?: string | null;
      system?: string | null;
      path?: string | null;
      level?: string | null;
      source_entity?: string | null;
      acquired_chapter?: number | null;
      summary?: string | null;
      chapter: number;
      confidence?: number;
    }
  ): boolean {
    this.assertChapter(row.chapter);
    const existing = this.db.prepare("SELECT id FROM abilities WHERE entity_id=? AND name=?").get(entityIdRef, row.name) as
      | { id: number }
      | undefined;
    if (existing) {
      // 更新为最新章节信息（保留结构，不产生脏数据）
      this.db
        .prepare(
          `UPDATE abilities SET chapter=?, confidence=?, category=COALESCE(?,category), system=COALESCE(?,system), path=COALESCE(?,path),
           level=COALESCE(?,level), source_entity=COALESCE(?,source_entity), acquired_chapter=COALESCE(?,acquired_chapter), summary=COALESCE(?,summary) WHERE id=?`
        )
        .run(
          row.chapter,
          row.confidence ?? 0.8,
          row.category ?? null,
          row.system ?? null,
          row.path ?? null,
          row.level ?? null,
          row.source_entity ?? null,
          row.acquired_chapter ?? null,
          row.summary ?? null,
          existing.id
        );
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO abilities(entity_id,name,category,system,path,level,source_entity,acquired_chapter,summary,chapter,confidence)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        entityIdRef,
        row.name,
        row.category ?? null,
        row.system ?? null,
        row.path ?? null,
        row.level ?? null,
        row.source_entity ?? null,
        row.acquired_chapter ?? null,
        row.summary ?? null,
        row.chapter,
        row.confidence ?? 0.8
      );
    return true;
  }
  listAbilities(entityIdRef?: string): AbilityRow[] {
    const f = this.chFilter("COALESCE(acquired_chapter,chapter)");
    if (entityIdRef) {
      return rows<AbilityRow>(
        this.db.prepare(`SELECT * FROM abilities WHERE entity_id=?${f} ORDER BY COALESCE(acquired_chapter,chapter)`).all(entityIdRef)
      );
    }
    return rows<AbilityRow>(this.db.prepare(`SELECT * FROM abilities WHERE 1=1${f} ORDER BY id`).all());
  }
  findAbilityByName(name: string): AbilityRow[] {
    return rows<AbilityRow>(this.db.prepare(`SELECT * FROM abilities WHERE name=?${this.chFilter("COALESCE(acquired_chapter,chapter)")}`).all(name));
  }

  // ---------- events ----------
  addEvent(chapter: number, participants: string[], type: string, summary: string, importance: number): boolean {
    this.assertChapter(chapter);
    // 简单去重：同章同摘要
    const dup = this.db.prepare("SELECT id FROM events WHERE chapter=? AND summary=?").get(chapter, summary) as
      | { id: number }
      | undefined;
    if (dup) return false;
    this.db.prepare("INSERT INTO events(chapter,participants,type,summary,importance) VALUES(?,?,?,?,?)").run(
      chapter,
      JSON.stringify(participants),
      type,
      summary,
      importance
    );
    return true;
  }
  listEvents(entityIdRef?: string): EventRow[] {
    const f = this.chFilter("chapter");
    if (entityIdRef) {
      const all = rows<EventRow>(this.db.prepare(`SELECT * FROM events WHERE 1=1${f} ORDER BY chapter`).all());
      return all.filter((e) => {
        try {
          const p = JSON.parse(e.participants) as string[];
          return p.includes(entityIdRef);
        } catch {
          return false;
        }
      });
    }
    return rows<EventRow>(this.db.prepare(`SELECT * FROM events WHERE 1=1${f} ORDER BY chapter`).all());
  }

  // ---------- memory anchors ----------
  addMemoryAnchor(
    entityIdRef: string,
    chapter: number,
    summary: string,
    importance: number,
    memorability: number,
    protagonistRelevance: number
  ): boolean {
    this.assertChapter(chapter);
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO memory_anchors(entity_id,chapter,summary,importance,memorability,protagonist_relevance) VALUES(?,?,?,?,?,?)"
      )
      .run(entityIdRef, chapter, summary, importance, memorability, protagonistRelevance);
    return r.changes > 0;
  }
  listMemoryAnchors(entityIdRef?: string): MemoryAnchorRow[] {
    const f = this.chFilter("chapter");
    if (entityIdRef) {
      return rows<MemoryAnchorRow>(this.db.prepare(`SELECT * FROM memory_anchors WHERE entity_id=?${f} ORDER BY chapter`).all(entityIdRef));
    }
    return rows<MemoryAnchorRow>(this.db.prepare(`SELECT * FROM memory_anchors WHERE 1=1${f} ORDER BY id`).all());
  }

  // ---------- appearances ----------
  recordAppearance(entityIdRef: string, chapter: number, mentions: number): void {
    this.assertChapter(chapter);
    this.db
      .prepare(
        "INSERT INTO entity_appearances(entity_id,chapter,mentions) VALUES(?,?,?) ON CONFLICT(entity_id,chapter) DO UPDATE SET mentions=max(mentions,excluded.mentions)"
      )
      .run(entityIdRef, chapter, mentions);
  }
  listAppearances(entityIdRef: string): { chapter: number; mentions: number }[] {
    return rows<{ chapter: number; mentions: number }>(
      this.db.prepare(`SELECT chapter, mentions FROM entity_appearances WHERE entity_id=?${this.chFilter("chapter")} ORDER BY chapter`).all(entityIdRef)
    );
  }
  firstAndLastAppearance(entityIdRef: string): { first: number | null; last: number | null; count: number } {
    const r = this.db
      .prepare(`SELECT MIN(chapter) AS first, MAX(chapter) AS last, COUNT(*) AS cnt FROM entity_appearances WHERE entity_id=?${this.chFilter("chapter")}`)
      .get(entityIdRef) as { first: number | null; last: number | null; cnt: number };
    return { first: r.first, last: r.last, count: r.cnt };
  }

  // ---------- duplicates / conflicts ----------
  addPossibleDuplicate(a: string, b: string, reason: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO possible_duplicates(entity_a,entity_b,reason,status) VALUES(?,?,?,'pending')")
      .run(a, b, reason);
    return r.changes > 0;
  }
  listPossibleDuplicates(status?: string): DuplicateRow[] {
    if (status) return rows<DuplicateRow>(this.db.prepare("SELECT * FROM possible_duplicates WHERE status=?").all(status));
    return rows<DuplicateRow>(this.db.prepare("SELECT * FROM possible_duplicates ORDER BY id").all());
  }
  setDuplicateStatus(id: number, status: string, note?: string): void {
    this.db.prepare("UPDATE possible_duplicates SET status=?, note=COALESCE(?,note) WHERE id=?").run(status, note ?? null, id);
  }
  addConflict(kind: string, entityIdRef: string | null, detail: string, chapterA: number | null, chapterB: number | null): void {
    this.db
      .prepare("INSERT INTO conflicts(kind,entity_id,detail,chapter_a,chapter_b,status) VALUES(?,?,?,?,?,'open')")
      .run(kind, entityIdRef, detail, chapterA, chapterB);
  }
  listConflicts(status?: string): ConflictRow[] {
    if (status) return rows<ConflictRow>(this.db.prepare("SELECT * FROM conflicts WHERE status=?").all(status));
    return rows<ConflictRow>(this.db.prepare("SELECT * FROM conflicts ORDER BY id").all());
  }
  setConflictStatus(id: number, status: string): void {
    this.db.prepare("UPDATE conflicts SET status=? WHERE id=?").run(status, id);
  }

  // ---------- llm logs ----------
  addLlmLog(row: {
    phase: string;
    model: string | null;
    range: string | null;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    success: boolean;
    retries: number;
    error?: string | null;
  }): void {
    this.db
      .prepare(
        "INSERT INTO llm_logs(phase,model,range,input_tokens,output_tokens,duration_ms,success,retries,error) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(
        row.phase,
        row.model ?? null,
        row.range ?? null,
        row.inputTokens,
        row.outputTokens,
        row.durationMs,
        row.success ? 1 : 0,
        row.retries,
        row.error ?? null
      );
  }
  llmLogSummary(): { calls: number; input: number; output: number; retries: number; duration: number; failures: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
                COALESCE(SUM(retries),0) AS retries, COALESCE(SUM(duration_ms),0) AS duration,
                SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures
         FROM llm_logs`
      )
      .get() as { calls: number; input: number; output: number; retries: number; duration: number; failures: number };
    return r;
  }

  // ---------- batch state（断点续跑） ----------
  getBatch(range: string): { status: string; summary: string | null } | null {
    const r = this.db.prepare("SELECT status, summary FROM batch_state WHERE range=?").get(range) as
      | { status: string; summary: string | null }
      | undefined;
    return r ?? null;
  }
  markBatch(
    range: string,
    start: number,
    end: number,
    status: "done" | "failed",
    counts: {
      newEntities: number;
      aliases: number;
      facts: number;
      relations: number;
      abilities: number;
      events: number;
      memoryAnchors: number;
      duplicates: number;
    },
    summary: string | null
  ): void {
    this.db
      .prepare(
        `INSERT INTO batch_state(range,start_chapter,end_chapter,status,summary,new_entities,aliases,facts,relations,abilities,events,memory_anchors,duplicates,finished_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
         ON CONFLICT(range) DO UPDATE SET status=excluded.status, summary=excluded.summary,
           new_entities=excluded.new_entities, aliases=excluded.aliases, facts=excluded.facts, relations=excluded.relations,
           abilities=excluded.abilities, events=excluded.events, memory_anchors=excluded.memory_anchors,
           duplicates=excluded.duplicates, finished_at=excluded.finished_at`
      )
      .run(
        range,
        start,
        end,
        status,
        summary ?? null,
        counts.newEntities,
        counts.aliases,
        counts.facts,
        counts.relations,
        counts.abilities,
        counts.events,
        counts.memoryAnchors,
        counts.duplicates
      );
  }
  listBatches(): { range: string; status: string }[] {
    return rows<{ range: string; status: string }>(this.db.prepare("SELECT range, status FROM batch_state ORDER BY start_chapter").all());
  }
  clearBatches(): void {
    this.db.exec("DELETE FROM batch_state");
  }

  // ---------- review log ----------
  addReviewLog(action: string, entityA: string | null, entityB: string | null, detail: string): void {
    this.db.prepare("INSERT INTO review_log(action,entity_a,entity_b,detail) VALUES(?,?,?,?)").run(action, entityA, entityB, detail);
  }

  /** 合并实体：把 fromId 的所有数据迁移到 toId（别名去重），删掉 fromId。 */
  mergeEntities(fromId: string, toId: string): void {
    const from = this.getEntity(fromId);
    const to = this.getEntity(toId);
    if (!from || !to) throw new Error(`合并失败：实体不存在 ${fromId} / ${toId}`);
    this.db.exec("BEGIN");
    try {
      const moveAliases = this.db.prepare("SELECT alias, from_chapter, note FROM aliases WHERE entity_id=?");
      for (const a of rows<{ alias: string; from_chapter: number; note: string | null }>(moveAliases.all(fromId))) {
        this.db.prepare("INSERT OR IGNORE INTO aliases(entity_id,alias,from_chapter,note) VALUES(?,?,?,?)").run(toId, a.alias, a.from_chapter, a.note);
        this.db.prepare("DELETE FROM aliases WHERE entity_id=? AND alias=?").run(fromId, a.alias);
      }
      const moveFacts = this.db.prepare("SELECT type,value,chapter,confidence,status FROM facts WHERE entity_id=?");
      for (const f of rows<{ type: string; value: string; chapter: number; confidence: number; status: string }>(moveFacts.all(fromId))) {
        this.db.prepare("INSERT OR IGNORE INTO facts(entity_id,type,value,chapter,confidence,status) VALUES(?,?,?,?,?,?)").run(
          toId,
          f.type,
          f.value,
          f.chapter,
          f.confidence,
          f.status
        );
      }
      this.db.prepare("DELETE FROM facts WHERE entity_id=?").run(fromId);
      this.db.prepare("UPDATE relations SET from_entity_id=? WHERE from_entity_id=?").run(toId, fromId);
      this.db.prepare("UPDATE relations SET to_entity_id=? WHERE to_entity_id=?").run(toId, fromId);
      this.db.prepare("DELETE FROM relations WHERE from_entity_id=to_entity_id").run();
      const moveAbilities = this.db.prepare("SELECT * FROM abilities WHERE entity_id=?");
      for (const a of rows<AbilityRow>(moveAbilities.all(fromId))) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO abilities(entity_id,name,category,system,path,level,source_entity,acquired_chapter,summary,chapter,confidence) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
          )
          .run(toId, a.name, a.category, a.system, a.path, a.level, a.source_entity, a.acquired_chapter, a.summary, a.chapter, a.confidence);
      }
      this.db.prepare("DELETE FROM abilities WHERE entity_id=?").run(fromId);
      const moveAnchors = this.db.prepare("SELECT chapter,summary,importance,memorability,protagonist_relevance,status FROM memory_anchors WHERE entity_id=?");
      for (const a of rows<{ chapter: number; summary: string; importance: number; memorability: number; protagonist_relevance: number; status: string }>(moveAnchors.all(fromId))) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO memory_anchors(entity_id,chapter,summary,importance,memorability,protagonist_relevance,status) VALUES(?,?,?,?,?,?,?)"
          )
          .run(toId, a.chapter, a.summary, a.importance, a.memorability, a.protagonist_relevance, a.status);
      }
      this.db.prepare("DELETE FROM memory_anchors WHERE entity_id=?").run(fromId);
      const moveAppearances = this.db.prepare("SELECT chapter, mentions FROM entity_appearances WHERE entity_id=?");
      for (const a of rows<{ chapter: number; mentions: number }>(moveAppearances.all(fromId))) {
        this.db.prepare("INSERT OR IGNORE INTO entity_appearances(entity_id,chapter,mentions) VALUES(?,?,?)").run(toId, a.chapter, a.mentions);
        this.db.prepare("DELETE FROM entity_appearances WHERE entity_id=?").run(fromId);
      }
      this.db.prepare("DELETE FROM possible_duplicates WHERE entity_a=? OR entity_b=?").run(fromId, fromId);
      this.db.prepare("UPDATE conflicts SET entity_id=? WHERE entity_id=?").run(toId, fromId);
      // 事件的参与者引用也要重写（先读后改，避免外部依赖）
      {
        const evRows = rows<{ id: number; participants: string }>(
          this.db.prepare("SELECT id, participants FROM events").all()
        );
        for (const ev of evRows) {
          let parts: string[] = [];
          try {
            parts = JSON.parse(ev.participants) as string[];
          } catch {
            continue;
          }
          if (parts.includes(fromId)) {
            const next = parts.map((x) => (x === fromId ? toId : x));
            const unique = [...new Set(next)];
            this.db.prepare("UPDATE events SET participants=? WHERE id=?").run(JSON.stringify(unique), ev.id);
          }
        }
      }
      // 更新 first/last seen
      const agg = this.db
        .prepare("SELECT MIN(chapter) AS first, MAX(chapter) AS last FROM entity_appearances WHERE entity_id=?")
        .get(toId) as { first: number | null; last: number | null };
      if (agg.first) {
        this.db
          .prepare("UPDATE entities SET first_seen_chapter=?, last_seen_chapter=? WHERE id=?")
          .run(Math.min(to.first_seen_chapter, from.first_seen_chapter), agg.last ?? to.last_seen_chapter, toId);
      }
      this.db.prepare("DELETE FROM entities WHERE id=?").run(fromId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 数据量统计（stats） */
  counts(): Record<string, number> {
    const q = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      entities: q("SELECT COUNT(*) AS n FROM entities"),
      characters: q("SELECT COUNT(*) AS n FROM entities WHERE type='character'"),
      aliases: q("SELECT COUNT(*) AS n FROM aliases"),
      facts: q("SELECT COUNT(*) AS n FROM facts"),
      relations: q("SELECT COUNT(*) AS n FROM relations"),
      abilities: q("SELECT COUNT(*) AS n FROM abilities"),
      events: q("SELECT COUNT(*) AS n FROM events"),
      memoryAnchors: q("SELECT COUNT(*) AS n FROM memory_anchors"),
      appearances: q("SELECT COUNT(*) AS n FROM entity_appearances"),
      pendingDuplicates: q("SELECT COUNT(*) AS n FROM possible_duplicates WHERE status='pending'"),
      openConflicts: q("SELECT COUNT(*) AS n FROM conflicts WHERE status='open'"),
      lowConfidenceFacts: q("SELECT COUNT(*) AS n FROM facts WHERE confidence < 0.65"),
      lowConfidenceRelations: q("SELECT COUNT(*) AS n FROM relations WHERE confidence < 0.65"),
    };
  }

  private assertChapter(chapter: number): void {
    if (!Number.isInteger(chapter) || chapter < 1 || chapter > this.maxChapter) {
      throw new Error(`章节号 ${chapter} 非法（必须在 1..${this.maxChapter}），拒绝写入结构化数据`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* noop */
    }
  }
}