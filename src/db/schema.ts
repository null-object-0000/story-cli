// SQLite Schema（node:sqlite DatabaseSync）
// 所有带 chapter 的表都内置 CHECK(chapter <= maxChapter)，从物理上保证“防剧透”。

export interface SchemaOptions {
  maxChapter: number;
  book: string;
}

// prettier-ignore
export const SCHEMA_SQL = (o: SchemaOptions) => `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  chapter INTEGER PRIMARY KEY CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  title   TEXT NOT NULL,
  text    TEXT NOT NULL,
  chars   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entities (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('character','organization','location','item','concept')),
  name             TEXT NOT NULL,
  first_seen_chapter INTEGER NOT NULL CHECK (first_seen_chapter >= 1 AND first_seen_chapter <= ${o.maxChapter}),
  last_seen_chapter  INTEGER CHECK (last_seen_chapter IS NULL OR (last_seen_chapter >= 1 AND last_seen_chapter <= ${o.maxChapter})),
  description      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  from_chapter INTEGER NOT NULL CHECK (from_chapter >= 1 AND from_chapter <= ${o.maxChapter}),
  note        TEXT,
  UNIQUE(entity_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

CREATE TABLE IF NOT EXISTS facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  value      TEXT NOT NULL,
  chapter    INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  confidence REAL NOT NULL DEFAULT 0.8,
  status     TEXT NOT NULL DEFAULT 'active',
  UNIQUE(entity_id, type, value, chapter)
);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);

CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  detail        TEXT,
  chapter       INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  confidence    REAL NOT NULL DEFAULT 0.8,
  status        TEXT NOT NULL DEFAULT 'active',
  CHECK (from_entity_id <> to_entity_id),
  UNIQUE(from_entity_id, to_entity_id, type, detail, chapter)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);

CREATE TABLE IF NOT EXISTS abilities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category        TEXT,
  system          TEXT,
  path            TEXT,
  level           TEXT,
  source_entity   TEXT,
  acquired_chapter INTEGER CHECK (acquired_chapter IS NULL OR (acquired_chapter >= 1 AND acquired_chapter <= ${o.maxChapter})),
  summary         TEXT,
  chapter         INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  confidence      REAL NOT NULL DEFAULT 0.8,
  UNIQUE(entity_id, name)
);
CREATE INDEX IF NOT EXISTS idx_abilities_name ON abilities(name);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter     INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  participants TEXT NOT NULL DEFAULT '[]',
  type        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 0.5,
  status      TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_events_chapter ON events(chapter);

CREATE TABLE IF NOT EXISTS memory_anchors (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id             TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chapter               INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  summary               TEXT NOT NULL,
  importance            REAL NOT NULL DEFAULT 0.5,
  memorability          REAL NOT NULL DEFAULT 0.7,
  protagonist_relevance REAL NOT NULL DEFAULT 0.5,
  status                TEXT NOT NULL DEFAULT 'active',
  UNIQUE(entity_id, chapter, summary)
);
CREATE INDEX IF NOT EXISTS idx_anchors_entity ON memory_anchors(entity_id);

CREATE TABLE IF NOT EXISTS entity_appearances (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chapter   INTEGER NOT NULL CHECK (chapter >= 1 AND chapter <= ${o.maxChapter}),
  mentions  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, chapter)
);
CREATE INDEX IF NOT EXISTS idx_appearances_entity ON entity_appearances(entity_id);

CREATE TABLE IF NOT EXISTS possible_duplicates (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_a  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  entity_b  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  reason    TEXT,
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','merged','rejected')),
  note      TEXT,
  CHECK (entity_a <> entity_b),
  UNIQUE(entity_a, entity_b)
);

CREATE TABLE IF NOT EXISTS conflicts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,
  entity_id TEXT,
  detail    TEXT NOT NULL,
  chapter_a INTEGER,
  chapter_b INTEGER,
  status    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed'))
);

CREATE TABLE IF NOT EXISTS llm_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  phase        TEXT NOT NULL,          -- 'extract' | 'ask' | 'other'
  model        TEXT,
  range        TEXT,                   -- 例如 "1-5"
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  success      INTEGER NOT NULL DEFAULT 1,
  retries      INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS batch_state (
  range          TEXT PRIMARY KEY,      -- 例如 "1-5"
  start_chapter  INTEGER NOT NULL,
  end_chapter    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'done',  -- done | failed
  summary        TEXT,                  -- 本批剧情摘要，供下一批参考
  new_entities   INTEGER NOT NULL DEFAULT 0,
  aliases        INTEGER NOT NULL DEFAULT 0,
  facts          INTEGER NOT NULL DEFAULT 0,
  relations      INTEGER NOT NULL DEFAULT 0,
  abilities      INTEGER NOT NULL DEFAULT 0,
  events         INTEGER NOT NULL DEFAULT 0,
  memory_anchors INTEGER NOT NULL DEFAULT 0,
  duplicates     INTEGER NOT NULL DEFAULT 0,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS review_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  action    TEXT NOT NULL,
  entity_a  TEXT,
  entity_b  TEXT,
  detail    TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/** 数据库完整性自检：确认 maxChapter 与配置一致 */
export function verifySchemaMax(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, maxChapter: number): void {
  const sql = "SELECT sql FROM sqlite_master WHERE type='table' AND name='facts'";
  const row = db.prepare(sql).get() as { sql?: string } | undefined;
  if (row && row.sql && !row.sql.includes(`chapter >= 1 AND chapter <= ${maxChapter}`)) {
    throw new Error(
      `story.db 的 schema 上限 (${extractMax(row.sql)}) 与配置 maxChapter (${maxChapter}) 不一致。\n` +
        `请重新运行 story init（或删除 .story/story.db 后重新 init + import + build）。`
    );
  }
}

function extractMax(sql: string): number {
  const m = /chapter <= (\d+)/.exec(sql);
  return m ? parseInt(m[1], 10) : -1;
}