// End-to-end test: real generateResponse() calls serialized by the inference lock.
// Runs ONLY against a copy of the database given by BRAIN_DB. Needs Ollama running.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-ai-lock.ts

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AI_MODULE = "./ai.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

// Child mode: two real generateResponse() calls, logging lock-held intervals.
if (process.argv[2] === "child") {
  const [, , , logFile, name] = process.argv;
  const ai = await import(AI_MODULE) as typeof import("./ai.js");
  let start = 0;
  ai.setInferenceLockHooks({
    onAcquire: () => { start = Date.now(); },
    onRelease: () => { appendFileSync(logFile!, `${name} ${start} ${Date.now()}\n`); }
  });
  for (let i = 0; i < 2; i++) {
    const out = await ai.generateResponse(
      [{ role: "user", content: 'Reply with exactly this JSON and nothing else: {"ok":true}' }],
      { format: "json", numPredict: 20, temperature: 0 }
    );
    const parsed = JSON.parse(out) as { ok?: unknown };
    if (parsed.ok !== true) throw new Error(`Unexpected output: ${out}`);
    appendFileSync(logFile!, `ok ${name} ${out.replace(/\s+/g, "")}\n`);
  }
  process.exit(0);
}

let failures = 0;
let total = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(path.join(tmpdir(), "ai-lock-"));
const self = fileURLToPath(import.meta.url);
const tsx = path.resolve("./node_modules/.bin/tsx");
const run = (args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; err: string }>(resolve => {
  const child = spawn(tsx, [self, ...args], { env, stdio: ["ignore", "inherit", "pipe"] });
  let err = "";
  child.stderr.on("data", d => { err += d; });
  child.on("exit", code => resolve({ code, err }));
});

// 1. Missing table on a fresh temp DB must throw the clear error (no unlocked fallback).
{
  const freshPath = path.join(dir, "fresh.sqlite");
  new Database(freshPath).close();
  process.env.BRAIN_DB = freshPath;
  const ai = await import(AI_MODULE) as typeof import("./ai.js");
  let err: unknown;
  try { await ai.generateResponse([{ role: "user", content: "hi" }]); } catch (e) { err = e; }
  check("missing table throws InferenceLockMissingError",
    err instanceof ai.InferenceLockMissingError, String(err));
  check("error message names migrate-inference-lock.ts",
    String(err).includes("migrate-inference-lock.ts"));
  const fresh = new Database(freshPath);
  check("no table created implicitly",
    !fresh.prepare(`SELECT 1 FROM sqlite_master WHERE name='inference_lock'`).get());
  fresh.close();
  process.env.BRAIN_DB = dbPath;
}

// 2. Two processes x two real Ollama calls never overlap.
const logFile = path.join(dir, "intervals.log");
const t0 = Date.now();
const results = await Promise.all(["p1", "p2"].map(n => run(["child", logFile, n], process.env)));
const elapsed = Date.now() - t0;
check("both children exited 0", results.every(r => r.code === 0), results.map(r => r.code + (r.err ? ` ${r.err.slice(0, 300)}` : "")));
const lines = readFileSync(logFile, "utf8").trim().split("\n");
const oks = lines.filter(l => l.startsWith("ok "));
check("all 4 calls returned {\"ok\":true}", oks.length === 4, oks);
const intervals = lines.filter(l => !l.startsWith("ok ")).map(l => l.split(" "))
  .map(([n, s, e]) => ({ n, s: Number(s), e: Number(e), ms: Number(e) - Number(s) }))
  .sort((a, b) => a.s - b.s);
check("4 lock-held intervals recorded", intervals.length === 4, intervals.map(i => `${i.n}:${i.ms}ms`));
const overlaps = intervals.slice(1).filter((iv, i) => iv.s < intervals[i]!.e);
check("no overlapping Ollama calls", overlaps.length === 0, overlaps);

const db = new Database(dbPath);
const row = db.prepare(`SELECT owner, lease_until FROM inference_lock WHERE name='ollama'`).get() as { owner: string | null };
check("lock row free at end", row.owner === null, row);
db.close();

console.log(`\nwall time ${elapsed}ms`);
console.log(`${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
