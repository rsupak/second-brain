// Stale-worker ownership test for evaluation_jobs.
// Imports the worker's real SQL from evaluation-jobs.ts.
// Runs ONLY against a copy of the database given by BRAIN_DB.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-stale-worker.ts

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createEvaluationJobStore, LeaseLostError, type EvaluationJob } from "./evaluation-jobs.js";
import type { Evaluation } from "./evaluations.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const store = createEvaluationJobStore(db);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const fake = (summary: string): Evaluation => ({
  feasibility: 3, cost: 2, relevance: 4, novelty: 3,
  summary, requirements: [], limitations: [], claims: []
});

function trySave(job: EvaluationJob, summary: string): "saved" | "lease-lost" | "other-error" {
  try { store.saveResult(job, fake(summary)); return "saved"; }
  catch (e) { return e instanceof LeaseLostError ? "lease-lost" : "other-error"; }
}

const row = (id: string) => db.prepare(`
  SELECT status, attempts, lease_owner, lease_until, run_after, error
  FROM evaluation_jobs WHERE id = ?
`).get(id) as { status: string; attempts: number; lease_owner: string | null;
  lease_until: number | null; run_after: number; error: string | null };

const ideaId = `stale-test-idea-${randomUUID()}`;
const jobId = `stale-test-job-${randomUUID()}`;
const exhaustedIdeaId = `stale-test-idea-${randomUUID()}`;
const exhaustedJobId = `stale-test-job-${randomUUID()}`;
const before = (db.prepare("SELECT COUNT(*) AS n FROM idea_evaluations").get() as { n: number }).n;

try {
  const addIdea = db.prepare(`
    INSERT INTO ideas (id, project_id, parent_id, title, content, origin, depth)
    VALUES (?, NULL, NULL, '[TEST] Stale worker', 'Temporary test row.', 'user', 0)
  `);
  addIdea.run(ideaId);
  db.prepare(`INSERT INTO evaluation_jobs (id, idea_id, status, attempts, run_after) VALUES (?, ?, 'pending', 0, 0)`)
    .run(jobId, ideaId);

  const a = store.claim();
  check("worker A claims the test job", a?.id === jobId, a?.id);
  if (!a || a.id !== jobId) throw new Error("Could not claim test job; aborting.");
  check("claim sets running, attempts=1, owner A", (() => {
    const r = row(jobId);
    return r.status === "running" && r.attempts === 1 && r.lease_owner === a.lease_owner && (r.lease_until ?? 0) > Date.now();
  })(), row(jobId));

  db.prepare("UPDATE evaluation_jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, jobId);
  check("A cannot save with an expired lease (not yet recovered)", trySave(a, "A expired") === "lease-lost");

  const b = store.claim();
  check("worker B recovers and claims the same job", b?.id === jobId, b?.id);
  if (!b) throw new Error("B could not claim; aborting.");
  check("B has a different token than A", b.lease_owner !== a.lease_owner);
  check("attempts incremented to 2", row(jobId).attempts === 2, row(jobId).attempts);

  check("A's save is rejected after B took over", trySave(a, "A stale result") === "lease-lost");
  check("A's failure update is rejected", store.fail(a, "stale failure").owned === false);
  check("job still running and owned by B", (() => {
    const r = row(jobId);
    return r.status === "running" && r.lease_owner === b.lease_owner;
  })(), row(jobId));
  const leaked = db.prepare("SELECT summary FROM idea_evaluations WHERE idea_id = ?").get(ideaId);
  check("no evaluation was written by A", leaked === undefined, leaked);

  check("B's save succeeds", trySave(b, "B result") === "saved");
  const done = row(jobId);
  check("completed job clears lease_owner, lease_until, run_after",
    done.status === "completed" && done.lease_owner === null && done.lease_until === null && done.run_after === 0, done);
  const saved = db.prepare("SELECT summary FROM idea_evaluations WHERE idea_id = ?").get(ideaId) as { summary: string } | undefined;
  check("saved evaluation is B's result", saved?.summary === "B result", saved);

  check("A cannot overwrite after completion", trySave(a, "A late") === "lease-lost" && store.fail(a, "late").owned === false);
  check("job remains completed with B's result", row(jobId).status === "completed" &&
    (db.prepare("SELECT summary FROM idea_evaluations WHERE idea_id = ?").get(ideaId) as { summary: string }).summary === "B result");

  // An expired job that already used every attempt is marked failed, not re-run.
  addIdea.run(exhaustedIdeaId);
  db.prepare(`INSERT INTO evaluation_jobs (id, idea_id, status, attempts, run_after, lease_until, lease_owner)
              VALUES (?, ?, 'running', 3, 0, ?, 'old-owner')`).run(exhaustedJobId, exhaustedIdeaId, Date.now() - 1);
  const c = store.claim();
  check("exhausted expired job is not claimed", c === undefined, c?.id);
  const ex = row(exhaustedJobId);
  check("exhausted expired job is marked failed and token cleared", ex.status === "failed" && ex.lease_owner === null, ex);
} finally {
  db.prepare("DELETE FROM idea_evaluations WHERE idea_id IN (?, ?)").run(ideaId, exhaustedIdeaId);
  db.prepare("DELETE FROM evaluation_jobs WHERE id IN (?, ?)").run(jobId, exhaustedJobId);
  db.prepare("DELETE FROM ideas WHERE id IN (?, ?) AND title = '[TEST] Stale worker'").run(ideaId, exhaustedIdeaId);
  const after = (db.prepare("SELECT COUNT(*) AS n FROM idea_evaluations").get() as { n: number }).n;
  check("test rows cleaned up; evaluation count unchanged", after === before, { before, after });
  db.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
