// Ownership-safe SQL for evaluation_jobs.
// Shared by evaluation-worker.ts and test-stale-worker.ts so the
// test always exercises the exact statements the worker runs.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Evaluation } from "./evaluations.js";

export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 10 * 60 * 1000;
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 5 * 60 * 1000;

export type EvaluationJob = {
  id: string;
  idea_id: string;
  attempts: number;
  lease_owner: string;
};

export class LeaseLostError extends Error {
  constructor(message = "Evaluation lease expired or ownership changed") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

export function createEvaluationJobStore(db: Database.Database) {
  const selectExpired = db.prepare(`
    SELECT id, attempts
    FROM evaluation_jobs
    WHERE status = 'running'
      AND (lease_until IS NULL OR lease_until <= ?)
  `);

  const failExpired = db.prepare(`
    UPDATE evaluation_jobs
    SET status = 'failed',
        lease_until = NULL,
        lease_owner = NULL,
        error = 'Evaluation lease expired after maximum attempts'
    WHERE id = ?
  `);

  const requeueExpired = db.prepare(`
    UPDATE evaluation_jobs
    SET status = 'pending',
        lease_until = NULL,
        lease_owner = NULL,
        run_after = ?,
        error = 'Recovered after worker interruption'
    WHERE id = ?
  `);

  const selectNext = db.prepare(`
    SELECT id, idea_id, attempts
    FROM evaluation_jobs
    WHERE status = 'pending'
      AND attempts < ?
      AND run_after <= ?
    ORDER BY created_at, rowid
    LIMIT 1
  `);

  const markClaimed = db.prepare(`
    UPDATE evaluation_jobs
    SET status = 'running',
        attempts = attempts + 1,
        lease_until = ?,
        lease_owner = ?,
        error = NULL
    WHERE id = ?
      AND status = 'pending'
  `);

  const checkOwnership = db.prepare(`
    SELECT id
    FROM evaluation_jobs
    WHERE id = ?
      AND status = 'running'
      AND lease_owner = ?
      AND lease_until > ?
  `);

  const upsertEvaluation = db.prepare(`
    INSERT INTO idea_evaluations (
      idea_id,
      feasibility,
      cost,
      relevance,
      novelty,
      summary,
      requirements,
      limitations,
      claims
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idea_id) DO UPDATE SET
      feasibility = excluded.feasibility,
      cost = excluded.cost,
      relevance = excluded.relevance,
      novelty = excluded.novelty,
      summary = excluded.summary,
      requirements = excluded.requirements,
      limitations = excluded.limitations,
      claims = excluded.claims,
      evaluated_at = CURRENT_TIMESTAMP
  `);

  const markCompleted = db.prepare(`
    UPDATE evaluation_jobs
    SET status = 'completed',
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
    UPDATE evaluation_jobs
    SET status = ?,
        error = ?,
        lease_until = NULL,
        lease_owner = NULL,
        run_after = ?
    WHERE id = ?
      AND lease_owner = ?
      AND status = 'running'
  `);

  const claimTx = db.transaction((): EvaluationJob | undefined => {
    const now = Date.now();

    // Recover interrupted jobs whose leases expired.
    // Clearing lease_owner invalidates the old worker's token.
    const expired = selectExpired.all(now) as Array<{ id: string; attempts: number }>;
    for (const job of expired) {
      if (job.attempts >= MAX_ATTEMPTS) failExpired.run(job.id);
      else requeueExpired.run(now, job.id);
    }

    const job = selectNext.get(MAX_ATTEMPTS, now) as
      | Omit<EvaluationJob, "lease_owner">
      | undefined;
    if (!job) return undefined;

    const leaseOwner = randomUUID();
    const claimed = markClaimed.run(now + LEASE_MS, leaseOwner, job.id);
    if (claimed.changes !== 1) return undefined;

    return { ...job, attempts: job.attempts + 1, lease_owner: leaseOwner };
  });

  const saveTx = db.transaction((job: EvaluationJob, evaluation: Evaluation) => {
    if (!checkOwnership.get(job.id, job.lease_owner, Date.now())) {
      throw new LeaseLostError();
    }

    upsertEvaluation.run(
      job.idea_id,
      evaluation.feasibility,
      evaluation.cost,
      evaluation.relevance,
      evaluation.novelty,
      evaluation.summary,
      JSON.stringify(evaluation.requirements),
      JSON.stringify(evaluation.limitations),
      JSON.stringify(evaluation.claims)
    );

    const done = markCompleted.run(job.id, job.lease_owner);
    if (done.changes !== 1) {
      // Rolls back the evaluation write as well.
      throw new LeaseLostError("Job completion did not match the lease owner");
    }
  });

  return {
    /** Atomically recover expired leases and claim the next job. */
    claim(): EvaluationJob | undefined {
      return claimTx.immediate();
    },

    /** Save the evaluation and complete the job, only if this worker still owns it. */
    saveResult(job: EvaluationJob, evaluation: Evaluation): void {
      saveTx.immediate(job, evaluation);
    },

    /** Record a failure, only if this worker still owns the job. */
    fail(job: EvaluationJob, message: string) {
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
