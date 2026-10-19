// Ownership-safe SQL for expand_idea jobs in the jobs table.
// Shared by worker.ts and test-stale-expansion.ts.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Idea } from "./ideas.js";

export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 10 * 60 * 1000;
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 5 * 60 * 1000;

export type ExpansionJob = {
  id: string;
  payload: string;
  attempts: number;
  lease_owner: string;
};

export type Branch = {
  title: string;
  explanation: string;
};

export class LeaseLostError extends Error {
  constructor(message = "Expansion lease expired or ownership changed") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

export function createExpansionJobStore(db: Database.Database) {
  // Expired jobs that have used every attempt would otherwise stay
  // 'running' forever, because the claim query skips them.
  const failExhausted = db.prepare(`
    UPDATE jobs
    SET status = 'failed',
        lease_until = NULL,
        lease_owner = NULL,
        error = 'Expansion lease expired after maximum attempts'
    WHERE type = 'expand_idea'
      AND status = 'running'
      AND (lease_until IS NULL OR lease_until <= ?)
      AND attempts >= ?
  `);

  const selectNext = db.prepare(`
    SELECT id, payload, attempts
    FROM jobs
    WHERE type = 'expand_idea'
      AND attempts < ?
      AND (
        (status = 'pending' AND run_after <= ?)
        OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
      )
    ORDER BY created_at, rowid
    LIMIT 1
  `);

  // Taking over an expired job replaces lease_owner,
  // which invalidates the previous worker's token.
  const markClaimed = db.prepare(`
    UPDATE jobs
    SET status = 'running',
        attempts = attempts + 1,
        lease_until = ?,
        lease_owner = ?,
        error = NULL
    WHERE id = ?
      AND attempts = ?
      AND (
        status = 'pending'
        OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
      )
  `);

  const checkOwnership = db.prepare(`
    SELECT id
    FROM jobs
    WHERE id = ?
      AND status = 'running'
      AND lease_owner = ?
      AND lease_until > ?
  `);

  const selectIdea = db.prepare(`SELECT * FROM ideas WHERE id = ?`);

  const countChildren = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ideas
    WHERE parent_id = ?
  `);

  const insertChild = db.prepare(`
    INSERT INTO ideas (
      id, project_id, parent_id,
      title, content, origin, depth
    )
    VALUES (?, ?, ?, ?, ?, 'ai', ?)
  `);

  const queueExpansion = db.prepare(`
    INSERT INTO jobs (id, type, payload, run_after)
    VALUES (?, 'expand_idea', ?, ?)
  `);

  const markCompleted = db.prepare(`
    UPDATE jobs
    SET status = 'completed',
        result = ?,
        completed_at = CURRENT_TIMESTAMP,
        error = NULL,
        lease_until = NULL,
        lease_owner = NULL,
        run_after = 0
    WHERE id = ?
      AND lease_owner = ?
      AND status = 'running'
  `);

  const markFailed = db.prepare(`
    UPDATE jobs
    SET status = ?,
        error = ?,
        lease_until = NULL,
        lease_owner = NULL,
        run_after = ?
    WHERE id = ?
      AND lease_owner = ?
      AND status = 'running'
  `);

  const claimTx = db.transaction((): ExpansionJob | undefined => {
    const now = Date.now();

    failExhausted.run(now, MAX_ATTEMPTS);

    const job = selectNext.get(MAX_ATTEMPTS, now, now) as
      | Omit<ExpansionJob, "lease_owner">
      | undefined;
    if (!job) return undefined;

    const leaseOwner = randomUUID();
    const claimed = markClaimed.run(
      now + LEASE_MS,
      leaseOwner,
      job.id,
      job.attempts,
      now
    );
    if (claimed.changes !== 1) return undefined;

    return { ...job, attempts: job.attempts + 1, lease_owner: leaseOwner };
  });

  // Verifies ownership, inserts children (unless a previous attempt already did),
  // queues tertiary expansions, and completes the job, all in one transaction.
  const completeTx = db.transaction((
    job: ExpansionJob,
    idea: Idea,
    branches: Branch[] | null
  ): number => {
    if (!checkOwnership.get(job.id, job.lease_owner, Date.now())) {
      throw new LeaseLostError();
    }

    const existing = (countChildren.get(idea.id) as { count: number }).count;
    let count = existing;

    if (existing === 0) {
      if (!branches) throw new Error("No branches to save");

      for (const branch of branches) {
        const childId = randomUUID();
        insertChild.run(
          childId,
          idea.project_id,
          idea.id,
          branch.title,
          branch.explanation,
          idea.depth + 1
        );

        // Automatically queue secondary ideas for tertiary expansion.
        if (idea.depth === 0) {
          queueExpansion.run(
            randomUUID(),
            JSON.stringify({ ideaId: childId }),
            Date.now()
          );
        }
      }
      count = branches.length;
    }

    const done = markCompleted.run(
      JSON.stringify({ children: count }),
      job.id,
      job.lease_owner
    );
    if (done.changes !== 1) {
      throw new LeaseLostError("Job completion did not match the lease owner");
    }

    return count;
  });

  return {
    /** Atomically claim the next pending or expired job. */
    claim(): ExpansionJob | undefined {
      return claimTx.immediate();
    },

    getIdea(id: string): Idea | undefined {
      return selectIdea.get(id) as Idea | undefined;
    },

    childCount(ideaId: string): number {
      return (countChildren.get(ideaId) as { count: number }).count;
    },

    /** Save children and complete the job, only if this worker still owns it. */
    complete(job: ExpansionJob, idea: Idea, branches: Branch[] | null): number {
      return completeTx.immediate(job, idea, branches);
    },

    /** Record a failure, only if this worker still owns the job. */
    fail(job: ExpansionJob, message: string) {
      const retry = job.attempts < MAX_ATTEMPTS;
      const delay = retryDelay(job.attempts);
      const result = markFailed.run(
        retry ? "pending" : "failed",
        message,
        retry ? Date.now() + delay : 0,
        job.id,
        job.lease_owner
      );
      return { owned: result.changes === 1, retry, delay };
    }
  };
}
