// Cross-process lease lock for Ollama inference.
// One row in inference_lock (name='ollama') guards the model so
// worker.ts and evaluation-worker.ts never call it at the same time.
// No SQLite transaction is held while the guarded function runs.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export const LOCK_NAME = "ollama";
export const LEASE_MS = 6 * 60 * 1000;
export const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;
export const BACKOFF_MIN_MS = 250;
export const BACKOFF_MAX_MS = 2000;

export class InferenceLockTimeoutError extends Error {
  constructor(message = "Timed out waiting for the inference lock") {
    super(message);
    this.name = "InferenceLockTimeoutError";
  }
}

export class InferenceLockLostError extends Error {
  constructor(message = "Inference lock lease was lost during generation") {
    super(message);
    this.name = "InferenceLockLostError";
  }
}

/** Idempotent: creates the table and the 'ollama' row if missing. Never drops data. */
export function ensureInferenceLockTable(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inference_lock (
        name TEXT PRIMARY KEY,
        owner TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER
      )
    `);
    db.prepare(`INSERT OR IGNORE INTO inference_lock (name, owner, lease_until) VALUES (?, NULL, 0)`)
      .run(LOCK_NAME);
  }).immediate();
}

export type InferenceLockOptions = {
  leaseMs?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
};

export type LockCallOptions = {
  timeoutMs?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  /** Optional instrumentation, called right after the lock is held. */
  onAcquire?: (owner: string) => void;
  /** Optional instrumentation, called right after the lock is released. */
  onRelease?: (owner: string) => void;
};

export function createInferenceLock(db: Database.Database, opts: InferenceLockOptions = {}) {
  const defaultLeaseMs = opts.leaseMs ?? LEASE_MS;
  const defaultTimeoutMs = opts.timeoutMs ?? WAIT_TIMEOUT_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  const takeLock = db.prepare(`
    UPDATE inference_lock
    SET owner = ?, lease_until = ?, acquired_at = ?
    WHERE name = ?
      AND (owner IS NULL OR lease_until <= ?)
  `);

  const renewLock = db.prepare(`
    UPDATE inference_lock
    SET lease_until = ?
    WHERE name = ?
      AND owner = ?
      AND lease_until > ?
  `);

  const releaseLock = db.prepare(`
    UPDATE inference_lock
    SET owner = NULL, lease_until = 0, acquired_at = NULL
    WHERE name = ?
      AND owner = ?
  `);

  const tryAcquireTx = db.transaction((owner: string, leaseMs: number): boolean => {
    const now = Date.now();
    return takeLock.run(owner, now + leaseMs, now, LOCK_NAME, now).changes === 1;
  });

  function tryAcquire(owner: string, leaseMs = defaultLeaseMs): boolean {
    return tryAcquireTx.immediate(owner, leaseMs);
  }

  function renew(owner: string, leaseMs = defaultLeaseMs): boolean {
    const now = Date.now();
    return renewLock.run(now + leaseMs, LOCK_NAME, owner, now).changes === 1;
  }

  function release(owner: string): boolean {
    return releaseLock.run(LOCK_NAME, owner).changes === 1;
  }

  async function acquire(
    owner: string,
    { timeoutMs = defaultTimeoutMs, leaseMs = defaultLeaseMs, signal }:
      { timeoutMs?: number; leaseMs?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = BACKOFF_MIN_MS;
    for (;;) {
      signal?.throwIfAborted();
      if (tryAcquire(owner, leaseMs)) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new InferenceLockTimeoutError();
      // Jittered backoff: sleep between 50% and 100% of delay, never past the deadline.
      const wait = Math.min(remaining, delay * (0.5 + Math.random() * 0.5));
      await sleep(wait, undefined, signal ? { signal } : undefined);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  // In-process queue so one process never competes with itself for the lock.
  let queue: Promise<unknown> = Promise.resolve();

  async function runLocked<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    callOpts: LockCallOptions
  ): Promise<T> {
    const owner = randomUUID();
    const leaseMs = callOpts.leaseMs ?? defaultLeaseMs;
    await acquire(owner, { ...callOpts, leaseMs });

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      let ok = false;
      try { ok = renew(owner, leaseMs); } catch { ok = false; }
      if (!ok) controller.abort(new InferenceLockLostError());
    }, heartbeatMs);
    heartbeat.unref();

    try {
      callOpts.onAcquire?.(owner);
      return await fn(controller.signal);
    } finally {
      clearInterval(heartbeat);
      try { release(owner); } catch { /* lease expires on its own */ }
      try { callOpts.onRelease?.(owner); } catch { /* instrumentation only */ }
    }
  }

  function withInferenceLock<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    callOpts: LockCallOptions = {}
  ): Promise<T> {
    const run = queue.then(() => runLocked(fn, callOpts));
    queue = run.catch(() => undefined);
    return run;
  }

  return { tryAcquire, renew, release, acquire, withInferenceLock };
}
