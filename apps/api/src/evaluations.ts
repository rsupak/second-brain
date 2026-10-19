import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const db = new Database("./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS idea_evaluations (
    idea_id TEXT PRIMARY KEY REFERENCES ideas(id)
      ON DELETE CASCADE,
    feasibility INTEGER NOT NULL,
    cost INTEGER NOT NULL,
    relevance INTEGER NOT NULL,
    novelty INTEGER NOT NULL,
    summary TEXT NOT NULL,
    requirements TEXT NOT NULL,
    limitations TEXT NOT NULL,
    claims TEXT NOT NULL,
    evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS evaluation_jobs (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL REFERENCES ideas(id),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','running','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluation_job_idea
    ON evaluation_jobs(idea_id);
`);

export const EvaluationSchema = z.object({
  feasibility: z.number().int().min(1).max(5),
  cost: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  novelty: z.number().int().min(1).max(5),
  summary: z.string().min(1),
  requirements: z.array(z.string()),
  limitations: z.array(z.string()),
  claims: z.array(z.object({
    claim: z.string(),
    status: z.enum([
      "unverified",
      "needs_external_evidence"
    ]),
    reason: z.string()
  }))
});

export type Evaluation = z.infer<typeof EvaluationSchema>;

export function queueEvaluations() {
  const ideas = db.prepare(`
    SELECT id FROM ideas
    WHERE id NOT IN (
      SELECT idea_id FROM idea_evaluations
    )
  `).all() as { id: string }[];

  let queued = 0;

  const insert = db.prepare(`
    INSERT INTO evaluation_jobs (id, idea_id)
    VALUES (?, ?)
    ON CONFLICT(idea_id) DO NOTHING
  `);

  const transaction = db.transaction(() => {
    for (const idea of ideas) {
      const result = insert.run(randomUUID(), idea.id);
      queued += result.changes;
    }
  });

  transaction();

  return { queued, candidates: ideas.length };
}

export function listEvaluations() {
  return db.prepare(`
    SELECT
      i.title,
      i.depth,
      e.*
    FROM idea_evaluations e
    JOIN ideas i ON i.id = e.idea_id
    ORDER BY
      (e.feasibility + e.relevance + e.novelty - e.cost)
      DESC
  `).all();
}
