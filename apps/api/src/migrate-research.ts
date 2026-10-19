// Idempotent migration: creates research_sources, research_chunks, research_findings.
// Safe to run repeatedly. Never drops or rewrites data.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/migrate-research.ts

import Database from "better-sqlite3";
import { ensureResearchTables, researchState } from "./research-schema.js";

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const before = researchState(db);
ensureResearchTables(db);
console.log(JSON.stringify({ db: dbPath, before, after: researchState(db) }));
db.close();
