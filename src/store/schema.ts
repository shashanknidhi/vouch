import type Database from "better-sqlite3";

export function applySchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      doc_ref TEXT NOT NULL,
      title TEXT NOT NULL,
      current_value TEXT,
      freshness_state TEXT NOT NULL DEFAULT 'fresh',
      author_hint TEXT
    );

    CREATE TABLE IF NOT EXISTS bindings (
      section_id TEXT PRIMARY KEY REFERENCES sections(id),
      slack_channel_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES sections(id),
      status TEXT NOT NULL DEFAULT 'open',
      source_signal TEXT,
      assignee TEXT,
      suggested_note TEXT,
      resolution_note TEXT
    );

    CREATE TABLE IF NOT EXISTS provenance (
      section_id TEXT NOT NULL REFERENCES sections(id),
      confirmed_by TEXT,
      confirmed_at TEXT,
      source_thread_id TEXT,
      source_slack_ref TEXT,
      human_confirmed INTEGER
    );
  `);
}
