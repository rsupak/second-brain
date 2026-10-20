// Idempotent, additive schema for skills (deep dives). Never drops, rewrites or recreates anything.
// Deep-dive jobs live in the existing jobs table with type 'deep_dive' (no schema change needed there).
import type Database from "better-sqlite3";

export const SKILL_TABLES = ["skills", "skill_versions", "skill_findings", "skill_sources", "skill_embeddings", "idea_embeddings"] as const;

export function ensureSkillTables(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      -- One skill per idea. Holds a copy of the CURRENT version's content; every version is kept in skill_versions.
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        idea_id TEXT NOT NULL REFERENCES ideas(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','ready','failed')),
        summary TEXT,
        sections TEXT,            -- JSON array of {key,title,kind,...}
        tags TEXT,                -- JSON array of strings
        version INTEGER NOT NULL DEFAULT 0,   -- current (latest completed) version; 0 = none yet
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(idea_id)
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id),
        version INTEGER NOT NULL,
        job_id TEXT,
        summary TEXT,
        sections TEXT NOT NULL,
        tags TEXT,
        stats TEXT,               -- JSON: durations, counts, models
        created_at INTEGER NOT NULL,
        UNIQUE(skill_id, version)
      );
      -- Verified findings of one skill version; quotes point at existing research_chunks.
      CREATE TABLE IF NOT EXISTS skill_findings (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id),
        version INTEGER NOT NULL,
        claim TEXT NOT NULL,
        quote TEXT NOT NULL,
        chunk_id TEXT NOT NULL REFERENCES research_chunks(id),
        verified INTEGER NOT NULL DEFAULT 1,
        question TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skill_findings_skill ON skill_findings(skill_id, version);
      -- Sources (existing research_sources rows) used by one skill version.
      CREATE TABLE IF NOT EXISTS skill_sources (
        skill_id TEXT NOT NULL REFERENCES skills(id),
        version INTEGER NOT NULL,
        source_id TEXT NOT NULL REFERENCES research_sources(id),
        cited INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (skill_id, version, source_id)
      );
      CREATE TABLE IF NOT EXISTS skill_embeddings (
        skill_id TEXT PRIMARY KEY REFERENCES skills(id),
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Cache of idea text embeddings for related-idea lookup (content_hash invalidates on edit).
      CREATE TABLE IF NOT EXISTS idea_embeddings (
        idea_id TEXT PRIMARY KEY REFERENCES ideas(id),
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status);
    `);
  }).immediate();
}

export function skillState(db: Database.Database) {
  const names = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(r => r.name));
  return Object.fromEntries(SKILL_TABLES.map(t => [t, names.has(t) ? (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n : null]));
}
