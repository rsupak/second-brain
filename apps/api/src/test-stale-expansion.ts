// Stale-worker ownership test for expand_idea jobs.
// Imports the worker's real SQL from expansion-jobs.ts. No Ollama calls.
// Runs ONLY against a copy of the database given by BRAIN_DB.
// Requires migrate-jobs-ownership.ts to have been run on that copy.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-stale-expansion.ts

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createExpansionJobStore, LeaseLostError, type Branch, type ExpansionJob } from "./expansion-jobs.js";
import type { Idea } from "./ideas.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
const store = createExpansionJobStore(db);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const branches = (tag: string): Branch[] => [1, 2, 3].map(n => ({
  title: `[TEST] ${tag} branch ${n}`, explanation: "Temporary test row."
}));

function tryComplete(job: ExpansionJob, idea: Idea, tag: string): "saved" | "lease-lost" | "other-error" {
  try { store.complete(job, idea, branches(tag)); return "saved"; }
  catch (e) { return e instanceof LeaseLostError ? "lease-lost" : "other-error"; }
}

const row = (id: string) => db.prepare(`
  SELECT status, attempts, lease_owner, lease_until, run_after, result
  FROM jobs WHERE id = ?
`).get(id) as { status: string; attempts: number; lease_owner: string | null;
  lease_until: number | null; run_after: number; result: string | null };

const children = (ideaId: string) =>
  db.prepare(`SELECT id, title FROM ideas WHERE parent_id = ? ORDER BY rowid`).all(ideaId) as { id: string; title: string }[];

const counts = () => db.prepare(`SELECT (SELECT COUNT(*) FROM ideas) AS ideas, (SELECT COUNT(*) FROM jobs) AS jobs`).get();
const before = counts();

const rootId = `stale-exp-idea-${randomUUID()}`;
const jobId = `stale-exp-job-${randomUUID()}`;
const exhaustedJobId = `stale-exp-job-${randomUUID()}`;

try {
  db.prepare(`
    INSERT INTO ideas (id, project_id, parent_id, title, content, origin, depth)
    VALUES (?, NULL, NULL, '[TEST] Stale expansion root', 'Temporary test row.', 'user', 0)
  `).run(rootId);
  db.prepare(`INSERT INTO jobs (id, type, payload, run_after) VALUES (?, 'expand_idea', ?, 0)`)
    .run(jobId, JSON.stringify({ ideaId: rootId }));
  const root = store.getIdea(rootId)!;

  const a = store.claim();
  check("worker A claims the test job", a?.id === jobId, a?.id);
  if (!a || a.id !== jobId) throw new Error("Could not claim test job; aborting.");
  check("claim sets running, attempts=1, owner A", (() => {
    const r = row(jobId);
    return r.status === "running" && r.attempts === 1 && r.lease_owner === a.lease_owner;
  })(), row(jobId));

  db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, jobId);
  check("A cannot complete with an expired lease", tryComplete(a, root, "A-expired") === "lease-lost");
  check("no children written by expired A", children(rootId).length === 0);

  const b = store.claim();
  check("worker B takes over the expired job", b?.id === jobId, b?.id);
  if (!b) throw new Error("B could not claim; aborting.");
  check("B has a different token; attempts=2", b.lease_owner !== a.lease_owner && row(jobId).attempts === 2, row(jobId));

  check("A's completion is rejected after takeover", tryComplete(a, root, "A-stale") === "lease-lost");
  check("A's failure update is rejected", store.fail(a, "stale failure").owned === false);
  check("still no children; job owned by B", children(rootId).length === 0 && row(jobId).lease_owner === b.lease_owner);

  check("B's completion succeeds", tryComplete(b, root, "B") === "saved");
  const kids = children(rootId);
  check("exactly 3 children, all from B", kids.length === 3 && kids.every(k => k.title.startsWith("[TEST] B ")), kids.map(k => k.title));
  const queued = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs WHERE type = 'expand_idea' AND status = 'pending'
      AND json_extract(payload, '$.ideaId') IN (SELECT id FROM ideas WHERE parent_id = ?)
  `).get(rootId) as { n: number };
  check("3 tertiary expansion jobs queued", queued.n === 3, queued.n);
  const done = row(jobId);
  check("completed job clears lease_owner, lease_until, run_after; result recorded",
    done.status === "completed" && done.lease_owner === null && done.lease_until === null &&
    done.run_after === 0 && done.result === JSON.stringify({ children: 3 }), done);

  check("A cannot write after completion", tryComplete(a, root, "A-late") === "lease-lost" && store.fail(a, "late").owned === false);
  check("still exactly 3 children", children(rootId).length === 3);

  // An expired job that already used every attempt is marked failed, not left running.
  db.prepare(`INSERT INTO jobs (id, type, payload, status, attempts, run_after, lease_until, lease_owner)
              VALUES (?, 'expand_idea', ?, 'running', 3, 0, ?, 'old-owner')`)
    .run(exhaustedJobId, JSON.stringify({ ideaId: rootId }), Date.now() - 1);
  // Park the queued tertiary jobs so the claim below can only see the exhausted job.
  db.prepare(`UPDATE jobs SET run_after = ? WHERE status = 'pending'
              AND json_extract(payload, '$.ideaId') IN (SELECT id FROM ideas WHERE parent_id = ?)`)
    .run(Date.now() + 3_600_000, rootId);
  const c = store.claim();
  check("exhausted expired job is not claimed", c === undefined, c?.id);
  const ex = row(exhaustedJobId);
  check("exhausted expired job is marked failed and token cleared", ex.status === "failed" && ex.lease_owner === null, ex);
} finally {
  const kidIds = children(rootId).map(k => k.id);
  for (const id of kidIds) {
    db.prepare(`DELETE FROM jobs WHERE type = 'expand_idea' AND json_extract(payload, '$.ideaId') = ?`).run(id);
    db.prepare(`DELETE FROM ideas WHERE id = ? AND title LIKE '[TEST] %'`).run(id);
  }
  db.prepare("DELETE FROM jobs WHERE id IN (?, ?)").run(jobId, exhaustedJobId);
  db.prepare("DELETE FROM ideas WHERE id = ? AND title = '[TEST] Stale expansion root'").run(rootId);
  const after = counts();
  check("test rows cleaned up; idea and job counts unchanged", JSON.stringify(after) === JSON.stringify(before), { before, after });
  db.close();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
