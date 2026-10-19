// Idempotent migration: adds lease_owner to the jobs table.
// Safe to run repeatedly. Never drops or rewrites data.
// Usage: npx tsx apps/api/src/migrate-jobs-ownership.ts
//        BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/migrate-jobs-ownership.ts

import Database from "better-sqlite3";

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const hasColumn = () =>
  (db.prepare(`SELECT name FROM pragma_table_info('jobs')`).all() as { name: string }[])
    .some(c => c.name === "lease_owner");

const before = hasColumn();

db.transaction(() => {
  if (!hasColumn()) {
    db.exec(`ALTER TABLE jobs ADD COLUMN lease_owner TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(lease_owner)`);
}).immediate();

const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all();
console.log(JSON.stringify({ db: dbPath, lease_owner_before: before, lease_owner_after: hasColumn(), jobs: counts }));
db.close();
