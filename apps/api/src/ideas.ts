import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL,
    lease_until INTEGER,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_ready
    ON jobs(status, run_after);
`);

export interface Idea {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  title: string;
  content: string;
  origin: string;
  depth: number;
  created_at: string;
}

export function getIdea(id: string): Idea | undefined {
  return db.prepare(
    "SELECT * FROM ideas WHERE id = ?"
  ).get(id) as Idea | undefined;
}

export function listIdeas(): Idea[] {
  return db.prepare(`
    SELECT * FROM ideas
    ORDER BY created_at DESC, rowid DESC
  `).all() as Idea[];
}

export function getIdeaTree(rootId: string): Idea[] {
  return db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT * FROM ideas WHERE id = ?
      UNION ALL
      SELECT child.*
      FROM ideas child
      JOIN tree parent ON child.parent_id = parent.id
    )
    SELECT * FROM tree
    ORDER BY depth, created_at
  `).all(rootId) as Idea[];
}

export function createIdea(
  title: string,
  content: string,
  parentId?: string,
  origin = "user"
): Idea {
  const parent = parentId ? getIdea(parentId) : undefined;

  if (parentId && !parent) {
    throw new Error("Parent idea not found");
  }

  const depth = parent ? parent.depth + 1 : 0;

  if (depth > 2) {
    throw new Error("Maximum idea depth exceeded");
  }

  const id = randomUUID();

  db.prepare(`
    INSERT INTO ideas (
      id, project_id, parent_id,
      title, content, origin, depth
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parent?.project_id ?? null,
    parentId ?? null,
    title,
    content,
    origin,
    depth
  );

  return getIdea(id)!;
}

export function enqueueExpansion(ideaId: string): string {
  const idea = getIdea(ideaId);

  if (!idea) throw new Error("Idea not found");
  if (idea.depth >= 2) {
    throw new Error("Tertiary ideas cannot expand further");
  }

  const existing = db.prepare(`
    SELECT id FROM jobs
    WHERE type = 'expand_idea'
      AND json_extract(payload, '$.ideaId') = ?
      AND status IN ('pending','running','completed')
    LIMIT 1
  `).get(ideaId) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = randomUUID();

  db.prepare(`
    INSERT INTO jobs (id, type, payload, run_after)
    VALUES (?, 'expand_idea', ?, ?)
  `).run(
    id,
    JSON.stringify({ ideaId }),
    Date.now()
  );

  return id;
}

export function createOriginalIdea(
  title: string,
  content: string
) {
  const idea = createIdea(title, content);
  const jobId = enqueueExpansion(idea.id);

  return { idea, jobId };
}

export function getJob(id: string) {
  return db.prepare(
    "SELECT * FROM jobs WHERE id = ?"
  ).get(id);
}
