// Idempotent schema for the research phase. Never drops or rewrites data.
import type Database from "better-sqlite3";

export const RESEARCH_TABLES = ["research_sources", "research_chunks", "research_findings"] as const;

export function ensureResearchTables(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_sources (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id),
        url TEXT NOT NULL,
        final_url TEXT,
        title TEXT,
        content_type TEXT,
        http_status INTEGER,
        content_hash TEXT,
        text TEXT,
        fetched_at INTEGER,
        error TEXT,
        UNIQUE(idea_id, url)
      );
      CREATE INDEX IF NOT EXISTS idx_research_sources_hash ON research_sources(content_hash);

      CREATE TABLE IF NOT EXISTS research_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES research_sources(id),
        idx INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_char INTEGER,
        end_char INTEGER,
        embedding BLOB,
        UNIQUE(source_id, idx)
      );

      CREATE TABLE IF NOT EXISTS research_findings (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id),
        claim TEXT NOT NULL,
        quote TEXT NOT NULL,
        chunk_id TEXT NOT NULL REFERENCES research_chunks(id),
        verified INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_findings_idea ON research_findings(idea_id);
      CREATE INDEX IF NOT EXISTS idx_research_findings_chunk ON research_findings(chunk_id);
    `);
  }).immediate();
}

export function researchState(db: Database.Database) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_%' ORDER BY name`
  ).all() as { name: string }[];
  return Object.fromEntries(tables.map(t => [
    t.name, (db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number }).n
  ]));
}
