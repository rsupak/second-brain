// Inference lock test. Runs ONLY against a copy of the database given by BRAIN_DB.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-inference-lock.ts

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createInferenceLock, ensureInferenceLockTable, InferenceLockTimeoutError } from "./inference-lock.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Child mode: take the lock 3 times, hold ~300ms, log intervals.
if (process.argv[2] === "child") {
  const [, , , logFile, name] = process.argv;
  const lock = createInferenceLock(db);
  for (let i = 0; i < 3; i++) {
    await lock.withInferenceLock(async () => {
      const start = Date.now();
      await sleep(300);
      appendFileSync(logFile!, `${name} ${start} ${Date.now()}\n`);
    }, { timeoutMs: 30000 });
  }
  db.close();
  process.exit(0);
}

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const row = () => db.prepare(`SELECT owner, lease_until FROM inference_lock WHERE name='ollama'`).get() as
  { owner: string | null; lease_until: number };

try {
  ensureInferenceLockTable(db);
  ensureInferenceLockTable(db);
  check("migration idempotent (one 'ollama' row)",
    (db.prepare(`SELECT COUNT(*) AS n FROM inference_lock`).get() as { n: number }).n === 1);
  check("lock starts free", row().owner === null, row());

  const lock = createInferenceLock(db);
  check("A tryAcquire succeeds", lock.tryAcquire("A", 60000));
  check("B tryAcquire fails while A holds", !lock.tryAcquire("B", 60000));
  check("B release refused", !lock.release("B"));
  check("owner still A", row().owner === "A");
  check("A renew ok", lock.renew("A", 60000));

  db.prepare(`UPDATE inference_lock SET lease_until = ? WHERE name='ollama'`).run(Date.now() - 1000);
  check("B takes over expired lease", lock.tryAcquire("B", 60000));
  check("A renew refused after takeover", !lock.renew("A", 60000));
  check("A release refused after takeover", !lock.release("A"));
  check("owner is B", row().owner === "B");
  check("B release ok", lock.release("B"));
  check("lock free after B release", row().owner === null && row().lease_until === 0, row());

  // Cross-process test.
  const dir = mkdtempSync(path.join(tmpdir(), "inference-lock-"));
  const logFile = path.join(dir, "intervals.log");
  const self = fileURLToPath(import.meta.url);
  const tsx = path.resolve("./node_modules/.bin/tsx");
  const codes = await Promise.all(["c1", "c2", "c3"].map(name => new Promise<number | null>(resolve => {
    const child = spawn(tsx, [self, "child", logFile, name], { stdio: "inherit", env: process.env });
    child.on("exit", code => resolve(code));
  })));
  check("all 3 children exited 0", codes.every(c => c === 0), codes);
  const intervals = readFileSync(logFile, "utf8").trim().split("\n")
    .map(l => l.split(" ")).map(([n, s, e]) => ({ n, s: Number(s), e: Number(e) }))
    .sort((a, b) => a.s - b.s);
  check("9 locked intervals recorded", intervals.length === 9, intervals.length);
  const overlaps = intervals.slice(1).filter((iv, i) => iv.s < intervals[i]!.e);
  check("no overlapping intervals across processes", overlaps.length === 0, overlaps);
  check("lock free after children", row().owner === null, row());

  // In-process queue: concurrent calls in one process run sequentially.
  const spans: Array<[number, number]> = [];
  await Promise.all([1, 2, 3].map(() => lock.withInferenceLock(async () => {
    const s = Date.now(); await sleep(100); spans.push([s, Date.now()]);
  })));
  spans.sort((a, b) => a[0] - b[0]);
  check("in-process calls do not overlap", spans.slice(1).every((sp, i) => sp[0] >= spans[i]![1]));

  // Heartbeat loss aborts fn.
  const hb = createInferenceLock(db, { heartbeatMs: 100 });
  const aborted = await hb.withInferenceLock(async signal => {
    db.prepare(`UPDATE inference_lock SET owner = 'intruder', lease_until = ? WHERE name='ollama'`).run(Date.now() + 60000);
    await sleep(400);
    return signal.aborted;
  });
  check("lost heartbeat aborts fn signal", aborted);
  check("finally release does not free intruder's lock", row().owner === "intruder");
  check("intruder release ok", lock.release("intruder"));

  // Timeout test.
  lock.tryAcquire("holder", 60000);
  const t0 = Date.now();
  let err: unknown;
  try { await lock.acquire("waiter", { timeoutMs: 800 }); } catch (e) { err = e; }
  const waited = Date.now() - t0;
  check("acquire times out with InferenceLockTimeoutError", err instanceof InferenceLockTimeoutError, String(err));
  check("timeout bounded (~800ms)", waited >= 750 && waited < 1500, waited);
  check("holder release ok", lock.release("holder"));
} finally {
  db.prepare(`UPDATE inference_lock SET owner = NULL, lease_until = 0, acquired_at = NULL WHERE name='ollama'`).run();
  check("lock row free at end", row().owner === null);
  db.close();
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
