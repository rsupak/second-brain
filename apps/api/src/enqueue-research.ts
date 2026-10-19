// Queue a research job for one idea. Refuses if an active (pending/running) one exists.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/enqueue-research.ts <ideaId>

import Database from "better-sqlite3";
import { createResearchJobStore } from "./research-jobs.js";

const ideaId = process.argv[2];
if (!ideaId) { console.error("Usage: enqueue-research.ts <ideaId>"); process.exit(2); }

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
try {
  const jobId = createResearchJobStore(db).enqueue(ideaId);
  console.log(JSON.stringify({ db: dbPath, queued: jobId, ideaId }));
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 1;
} finally { db.close(); }
