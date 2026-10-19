
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database("./data/brain.sqlite");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const TEST_ID = "recovery-test-001";

type TestJob = {
  id: string;
  status: string;
  attempts: number;
  run_after: number;
  lease_until: number | null;
  error: string | null;
};

function getTestJob(): TestJob | undefined {
  return db.prepare(`
    SELECT id, status, attempts, run_after, lease_until, error
    FROM evaluation_jobs
    WHERE id = ?
  `).get(TEST_ID) as TestJob | undefined;
}

function setup() {
  const idea = db.prepare(`
    SELECT id
    FROM ideas
    ORDER BY created_at, rowid
    LIMIT 1
  `).get() as { id: string } | undefined;

  if (!idea) {
    throw new Error("No ideas exist for the recovery test.");
  }

  const existing = getTestJob();

  if (existing) {
    throw new Error(
      "Test job already exists. Run cleanup before setup."
    );
  }

  // Simulate a worker that claimed a job,
  // then crashed before completing it.
  //
  // Use a unique idea ID so existing evaluations
  // and their jobs are never modified.

  const testIdeaId = randomUUID();

  const project = db.prepare(`
    SELECT project_id
    FROM ideas
    WHERE id = ?
  `).get(idea.id) as { project_id: string | null };

  db.transaction(() => {
    db.prepare(`
      INSERT INTO ideas (
        id, project_id, title, content, origin, depth
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      testIdeaId,
      project.project_id,
      "[TEST] Evaluation Worker Recovery",
      "Temporary test idea for evaluating worker recovery.",
      "user",
      0
    );

    db.prepare(`
      INSERT INTO evaluation_jobs (
        id, idea_id, status, attempts,
        run_after, lease_until, error
      )
      VALUES (?, ?, 'running', 1, 0, ?, ?)
    `).run(
      TEST_ID,
      testIdeaId,
      Date.now() - 1000,
      "Simulated worker interruption"
    );
  })();

  console.log("Created an expired running test job.");
  console.log(getTestJob());
}

function inspect() {
  console.log(getTestJob() ?? "Test job not found.");
}

function cleanup() {
  db.transaction(() => {
    const job = db.prepare(`
      SELECT idea_id
      FROM evaluation_jobs
      WHERE id = ?
    `).get(TEST_ID) as { idea_id: string } | undefined;

    if (!job) {
      console.log("No test job to clean up.");
      return;
    }

    db.prepare(`
      DELETE FROM evaluation_jobs
      WHERE id = ?
    `).run(TEST_ID);

    db.prepare(`
      DELETE FROM idea_evaluations
      WHERE idea_id = ?
    `).run(job.idea_id);

    db.prepare(`
      DELETE FROM ideas
      WHERE id = ?
        AND title = '[TEST] Evaluation Worker Recovery'
    `).run(job.idea_id);

    console.log("Test job and temporary idea removed.");
  })();
}

try {
  const command = process.argv[2];

  switch (command) {
    case "setup":
      setup();
      break;

    case "inspect":
      inspect();
      break;

    case "cleanup":
      cleanup();
      break;

    default:
      console.log(
        "Usage: npx tsx apps/api/src/test-evaluation-recovery.ts setup|inspect|cleanup"
      );
  }
} finally {
  db.close();
}
