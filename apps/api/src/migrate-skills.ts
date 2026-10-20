// Idempotent migration: creates the skills tables (see skills-schema.ts). Safe to run repeatedly; never drops data.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/migrate-skills.ts
import Database from "better-sqlite3";
import { ensureSkillTables, skillState } from "./skills-schema.js";

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
const before = skillState(db);
ensureSkillTables(db);
console.log(JSON.stringify({ db: dbPath, before, after: skillState(db) }));
db.close();
