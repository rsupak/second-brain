// Idempotent migration: creates inference_lock and its 'ollama' row.
// Safe to run repeatedly. Never drops or rewrites data.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/migrate-inference-lock.ts

import Database from "better-sqlite3";
import { ensureInferenceLockTable } from "./inference-lock.js";

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const state = () => ({
  table: !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='inference_lock'`).get(),
  rows: (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='inference_lock'`).get() as { n: number }).n
    ? db.prepare(`SELECT name, owner, lease_until FROM inference_lock`).all()
    : []
});

const before = state();
ensureInferenceLockTable(db);
console.log(JSON.stringify({ db: dbPath, before, after: state() }));
db.close();
