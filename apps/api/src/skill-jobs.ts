// Skills + ownership-safe 'deep_dive' jobs in the existing jobs table. Same lease pattern as research-jobs.ts:
// claim sets a random lease_owner; completion/failure only apply while that owner still holds the lease.
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const DEEP_DIVE_JOB = "deep_dive";
export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 60 * 60 * 1000;   // deep dives can wait on the shared inference lock for a long time
export const RETRY_BASE_MS = 60 * 1000;
export const RETRY_MAX_MS = 10 * 60 * 1000;

export type DeepDiveJob = { id: string; payload: string; attempts: number; lease_owner: string };
export type DeepDivePayload = { skillId: string; ideaId: string; version: number };
export type SkillSection = { key: string; title: string; kind: "synthesis" | "verified" | "computed"; text?: string; items?: unknown[] };
export type SkillFindingInput = { claim: string; quote: string; chunk_id: string; question: string | null };
export type SkillVersionInput = {
  summary: string; sections: SkillSection[]; tags: string[]; stats: Record<string, unknown>;
  findings: SkillFindingInput[]; sources: Array<{ source_id: string; cited: boolean }>;
  embedding?: { model: string; vector: Buffer } | null;
};

export class LeaseLostError extends Error {
  constructor(message = "Deep-dive lease expired or ownership changed") { super(message); this.name = "LeaseLostError"; }
}
export class ActiveDeepDiveError extends Error {
  constructor(readonly skillId: string, readonly jobId: string) { super(`Skill ${skillId} already has an active deep-dive job (${jobId})`); this.name = "ActiveDeepDiveError"; }
}
export class SkillExistsError extends Error {
  constructor(readonly skillId: string) { super(`A skill already exists for this idea (${skillId})`); this.name = "SkillExistsError"; }
}
export class NotFoundError extends Error {}

export const retryDelay = (attempts: number) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

export function createSkillStore(db: Database.Database) {
  const T = DEEP_DIVE_JOB;
  const failExhausted = db.prepare(`
    UPDATE jobs SET status = 'failed', lease_until = NULL, lease_owner = NULL, error = 'Deep-dive lease expired after maximum attempts'
    WHERE type = '${T}' AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?) AND attempts >= ?
    RETURNING json_extract(payload, '$.skillId') AS skillId`);
  const selectNext = db.prepare(`
    SELECT id, payload, attempts FROM jobs
    WHERE type = '${T}' AND attempts < ?
      AND ((status = 'pending' AND run_after <= ?) OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?)))
    ORDER BY created_at, rowid LIMIT 1`);
  const markClaimed = db.prepare(`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, lease_owner = ?, error = NULL
    WHERE id = ? AND type = '${T}' AND attempts = ?
      AND (status = 'pending' OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?)))`);
  const checkOwnership = db.prepare(`SELECT id FROM jobs WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?`);
  const markCompleted = db.prepare(`
    UPDATE jobs SET status = 'completed', result = ?, completed_at = CURRENT_TIMESTAMP, error = NULL,
      lease_until = NULL, lease_owner = NULL, run_after = 0
    WHERE id = ? AND lease_owner = ? AND status = 'running'`);
  const markFailed = db.prepare(`
    UPDATE jobs SET status = ?, error = ?, lease_until = NULL, lease_owner = NULL, run_after = ?
    WHERE id = ? AND lease_owner = ? AND status = 'running'`);
  const selectActive = db.prepare(`
    SELECT id FROM jobs WHERE type = '${T}' AND status IN ('pending','running') AND json_extract(payload, '$.skillId') = ? LIMIT 1`);
  const insertJob = db.prepare(`INSERT INTO jobs (id, type, payload, run_after) VALUES (?, '${T}', ?, ?)`);
  const ideaById = db.prepare(`SELECT id, title FROM ideas WHERE id = ?`);
  const skillByIdea = db.prepare(`SELECT id FROM skills WHERE idea_id = ?`);
  const skillById = db.prepare(`SELECT id, idea_id, version FROM skills WHERE id = ?`);
  const insertSkill = db.prepare(`INSERT INTO skills (id, idea_id, title, status, version, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)`);
  const setStatus = db.prepare(`UPDATE skills SET status = ?, error = ?, updated_at = ? WHERE id = ?`);
  const maxVersion = db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM skill_versions WHERE skill_id = ?`).pluck();
  const insertVersion = db.prepare(`INSERT INTO skill_versions (id, skill_id, version, job_id, summary, sections, tags, stats, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFinding = db.prepare(`INSERT INTO skill_findings (id, skill_id, version, claim, quote, chunk_id, verified, question, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const insertSource = db.prepare(`INSERT OR IGNORE INTO skill_sources (skill_id, version, source_id, cited) VALUES (?, ?, ?, ?)`);
  const updateSkill = db.prepare(`UPDATE skills SET status = 'ready', error = NULL, summary = ?, sections = ?, tags = ?, version = ?, updated_at = ? WHERE id = ?`);
  const upsertEmbedding = db.prepare(`INSERT INTO skill_embeddings (skill_id, model, vector, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET model = excluded.model, vector = excluded.vector, updated_at = excluded.updated_at`);

  const queue = (skillId: string, ideaId: string, version: number) => {
    const active = selectActive.get(skillId) as { id: string } | undefined;
    if (active) throw new ActiveDeepDiveError(skillId, active.id);
    const id = randomUUID();
    insertJob.run(id, JSON.stringify({ skillId, ideaId, version } satisfies DeepDivePayload), Date.now());
    setStatus.run("pending", null, Date.now(), skillId);
    return id;
  };

  const createTx = db.transaction((ideaId: string) => {
    const idea = ideaById.get(ideaId) as { id: string; title: string } | undefined;
    if (!idea) throw new NotFoundError("Idea not found");
    const existing = skillByIdea.get(ideaId) as { id: string } | undefined;
    if (existing) {
      const active = selectActive.get(existing.id) as { id: string } | undefined;
      if (active) throw new ActiveDeepDiveError(existing.id, active.id);
      throw new SkillExistsError(existing.id);
    }
    const skillId = randomUUID(), now = Date.now();
    insertSkill.run(skillId, ideaId, idea.title, now, now);
    return { skillId, ideaId, version: 1, jobId: queue(skillId, ideaId, 1) };
  });

  const refreshTx = db.transaction((skillId: string) => {
    const s = skillById.get(skillId) as { id: string; idea_id: string; version: number } | undefined;
    if (!s) throw new NotFoundError("Skill not found");
    const version = (maxVersion.get(skillId) as number) + 1;
    return { skillId, ideaId: s.idea_id, version, jobId: queue(skillId, s.idea_id, version) };
  });

  const claimTx = db.transaction((): DeepDiveJob | undefined => {
    const now = Date.now();
    for (const r of failExhausted.all(now, MAX_ATTEMPTS) as { skillId: string }[]) setStatus.run("failed", "Deep-dive lease expired after maximum attempts", now, r.skillId);
    const job = selectNext.get(MAX_ATTEMPTS, now, now) as Omit<DeepDiveJob, "lease_owner"> | undefined;
    if (!job) return undefined;
    const owner = randomUUID();
    if (markClaimed.run(now + LEASE_MS, owner, job.id, job.attempts, now).changes !== 1) return undefined;
    const p = JSON.parse(job.payload) as DeepDivePayload;
    setStatus.run("running", null, now, p.skillId);
    return { ...job, attempts: job.attempts + 1, lease_owner: owner };
  });

  // Ownership check + new version + findings/sources + current copy + job completion in one transaction. Old versions are never touched.
  const completeTx = db.transaction((job: DeepDiveJob, v: SkillVersionInput) => {
    const now = Date.now();
    if (!checkOwnership.get(job.id, job.lease_owner, now)) throw new LeaseLostError();
    const p = JSON.parse(job.payload) as DeepDivePayload;
    const version = Math.max(p.version, (maxVersion.get(p.skillId) as number) + 1);
    insertVersion.run(randomUUID(), p.skillId, version, job.id, v.summary, JSON.stringify(v.sections), JSON.stringify(v.tags), JSON.stringify(v.stats), now);
    for (const f of v.findings) insertFinding.run(randomUUID(), p.skillId, version, f.claim, f.quote, f.chunk_id, f.question, now);
    for (const s of v.sources) insertSource.run(p.skillId, version, s.source_id, s.cited ? 1 : 0);
    updateSkill.run(v.summary, JSON.stringify(v.sections), JSON.stringify(v.tags), version, now, p.skillId);
    if (v.embedding) upsertEmbedding.run(p.skillId, v.embedding.model, v.embedding.vector, now);
    const result = { ...v.stats, version, findings: v.findings.length, sources: v.sources.length };
    if (markCompleted.run(JSON.stringify(result), job.id, job.lease_owner).changes !== 1) throw new LeaseLostError("Job completion did not match the lease owner");
    return result;
  });

  const failTx = db.transaction((job: DeepDiveJob, message: string) => {
    const retry = job.attempts < MAX_ATTEMPTS, delay = retryDelay(job.attempts);
    const r = markFailed.run(retry ? "pending" : "failed", message, retry ? Date.now() + delay : 0, job.id, job.lease_owner);
    if (r.changes === 1) {
      const p = JSON.parse(job.payload) as DeepDivePayload;
      setStatus.run(retry ? "pending" : "failed", message.slice(0, 500), Date.now(), p.skillId);
    }
    return { owned: r.changes === 1, retry, delay };
  });

  return {
    create: (ideaId: string) => createTx.immediate(ideaId),
    refresh: (skillId: string) => refreshTx.immediate(skillId),
    claim: (): DeepDiveJob | undefined => claimTx.immediate(),
    owns: (job: DeepDiveJob) => !!checkOwnership.get(job.id, job.lease_owner, Date.now()),
    complete: (job: DeepDiveJob, v: SkillVersionInput) => completeTx.immediate(job, v),
    fail: (job: DeepDiveJob, message: string) => failTx.immediate(job, message)
  };
}
