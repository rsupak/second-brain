// Ownership-safe SQL for research_idea jobs in the jobs table.
// Mirrors expansion-jobs.ts. Shared by research-worker.ts, enqueue-research.ts
// and test-research-pipeline.ts.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const JOB_TYPE = "research_idea";
export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 20 * 60 * 1000;
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_MAX_MS = 5 * 60 * 1000;

export type ResearchJob = {
  id: string;
  payload: string;
  attempts: number;
  lease_owner: string;
};

export type NewFinding = { claim: string; quote: string; chunk_id: string };

export class LeaseLostError extends Error {
  constructor(message = "Research lease expired or ownership changed") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class ActiveResearchJobError extends Error {
  constructor(ideaId: string, jobId: string) {
    super(`Idea ${ideaId} already has an active research job (${jobId})`);
    this.name = "ActiveResearchJobError";
  }
}

export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

export function createResearchJobStore(db: Database.Database) {
  const failExhausted = db.prepare(`
    UPDATE jobs
    SET status = 'failed', lease_until = NULL, lease_owner = NULL,
        error = 'Research lease expired after maximum attempts'
    WHERE type = '${JOB_TYPE}'
      AND status = 'running'
      AND (lease_until IS NULL OR lease_until <= ?)
      AND attempts >= ?
  `);

  const selectNext = db.prepare(`
    SELECT id, payload, attempts
    FROM jobs
    WHERE type = '${JOB_TYPE}'
      AND attempts < ?
      AND (
        (status = 'pending' AND run_after <= ?)
        OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
      )
    ORDER BY created_at, rowid
    LIMIT 1
  `);

  const markClaimed = db.prepare(`
    UPDATE jobs
    SET status = 'running', attempts = attempts + 1,
        lease_until = ?, lease_owner = ?, error = NULL
    WHERE id = ?
      AND type = '${JOB_TYPE}'
      AND attempts = ?
      AND (
        status = 'pending'
        OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
      )
  `);

  const checkOwnership = db.prepare(`
    SELECT id FROM jobs
    WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
  `);

  const findDuplicate = db.prepare(`
    SELECT 1 FROM research_findings WHERE idea_id = ? AND chunk_id = ? AND quote = ?
  `);

  const insertFinding = db.prepare(`
    INSERT INTO research_findings (id, idea_id, claim, quote, chunk_id, verified, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);

  const markCompleted = db.prepare(`
    UPDATE jobs
    SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP,
        error = NULL, lease_until = NULL, lease_owner = NULL, run_after = 0
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const markFailed = db.prepare(`
    UPDATE jobs
    SET status = ?, error = ?, lease_until = NULL, lease_owner = NULL, run_after = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'
  `);

  const selectActive = db.prepare(`
    SELECT id FROM jobs
    WHERE type = '${JOB_TYPE}'
      AND status IN ('pending', 'running')
      AND json_extract(payload, '$.ideaId') = ?
    LIMIT 1
  `);

  const ideaExists = db.prepare(`SELECT 1 FROM ideas WHERE id = ?`);

  const insertJob = db.prepare(`
    INSERT INTO jobs (id, type, payload, run_after) VALUES (?, '${JOB_TYPE}', ?, ?)
  `);

  const claimTx = db.transaction((): ResearchJob | undefined => {
    const now = Date.now();
    failExhausted.run(now, MAX_ATTEMPTS);
    const job = selectNext.get(MAX_ATTEMPTS, now, now) as Omit<ResearchJob, "lease_owner"> | undefined;
    if (!job) return undefined;
    const leaseOwner = randomUUID();
    const claimed = markClaimed.run(now + LEASE_MS, leaseOwner, job.id, job.attempts, now);
    if (claimed.changes !== 1) return undefined;
    return { ...job, attempts: job.attempts + 1, lease_owner: leaseOwner };
  });

  // Ownership check, findings insert (deduplicated, never deleting) and completion in one tx.
  const completeTx = db.transaction((
    job: ResearchJob, ideaId: string, findings: NewFinding[], result: Record<string, unknown>
  ) => {
    if (!checkOwnership.get(job.id, job.lease_owner, Date.now())) throw new LeaseLostError();
    let inserted = 0, duplicates = 0;
    const now = Date.now();
    for (const f of findings) {
      if (findDuplicate.get(ideaId, f.chunk_id, f.quote)) { duplicates++; continue; }
      insertFinding.run(randomUUID(), ideaId, f.claim, f.quote, f.chunk_id, now);
      inserted++;
    }
    const full = { ...result, findingsInserted: inserted, findingsDuplicate: duplicates };
    const done = markCompleted.run(JSON.stringify(full), job.id, job.lease_owner);
    if (done.changes !== 1) throw new LeaseLostError("Job completion did not match the lease owner");
    return full;
  });

  const enqueueTx = db.transaction((ideaId: string): string => {
    if (!ideaExists.get(ideaId)) throw new Error(`Idea not found: ${ideaId}`);
    const active = selectActive.get(ideaId) as { id: string } | undefined;
    if (active) throw new ActiveResearchJobError(ideaId, active.id);
    const id = randomUUID();
    insertJob.run(id, JSON.stringify({ ideaId }), Date.now());
    return id;
  });

  return {
    claim(): ResearchJob | undefined { return claimTx.immediate(); },

    /** Still owned with an unexpired lease (read-only, for early bail-out). */
    owns(job: ResearchJob): boolean { return !!checkOwnership.get(job.id, job.lease_owner, Date.now()); },

    complete(job: ResearchJob, ideaId: string, findings: NewFinding[], result: Record<string, unknown>) {
      return completeTx.immediate(job, ideaId, findings, result);
    },

    fail(job: ResearchJob, message: string) {
      const retry = job.attempts < MAX_ATTEMPTS;
      const delay = retryDelay(job.attempts);
      const r = markFailed.run(retry ? "pending" : "failed", message,
        retry ? Date.now() + delay : 0, job.id, job.lease_owner);
      return { owned: r.changes === 1, retry, delay };
    },

    enqueue(ideaId: string): string { return enqueueTx.immediate(ideaId); }
  };
}
