// Deep-dive worker: claims 'deep_dive' jobs (lease-owned) and writes a new skill version per job.
import Database from "better-sqlite3";
import { embedTexts, generateResponse } from "./ai.js";
import { liveFetch, searxngSearch, type Idea } from "./research.js";
import { ensureSkillTables } from "./skills-schema.js";
import { createSkillStore, MAX_ATTEMPTS, type DeepDiveJob, type DeepDivePayload } from "./skill-jobs.js";
import { runDeepDive } from "./deep-dive.js";

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
ensureSkillTables(db);

const POLL_MS = 5000;
const store = createSkillStore(db);
const search = searxngSearch();
const searchScience = searxngSearch(undefined, { categories: "science" });   // scholarly queries only
const ONCE = process.env.DEEP_DIVE_ONCE === "1";   // test mode: process one job then exit

async function processJob(job: DeepDiveJob) {
  try {
    const { skillId, ideaId, version } = JSON.parse(job.payload) as DeepDivePayload;
    const idea = db.prepare(`SELECT id, title, content FROM ideas WHERE id = ?`).get(ideaId) as Idea | undefined;
    if (!idea) throw new Error("Idea not found");
    console.log(`Deep dive v${version}: ${idea.title}`);
    const v = await runDeepDive(db, skillId, idea, {
      search, searchScience, fetch: liveFetch, embed: texts => embedTexts(texts), llm: generateResponse,
      log: m => console.log(`  ${m}`), stillOwned: () => store.owns(job)
    });
    const result = store.complete(job, v);
    console.log(`Completed ${job.id}: ${JSON.stringify(result)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { owned, retry, delay } = store.fail(job, message);
    if (!owned) { console.warn(`Job ${job.id} is no longer owned by this worker; result discarded.`); return; }
    console.error(`Job ${job.id} failed (${job.attempts}/${MAX_ATTEMPTS}): ${message}`);
    if (retry) console.log(`Retry scheduled in ${Math.round(delay / 1000)} seconds`);
  }
}

let busy = false, shuttingDown = false;
async function tick() {
  if (busy) return;
  busy = true;
  let did = false;
  try { const job = store.claim(); if (job) { did = true; await processJob(job); } }
  catch (error) { console.error("Deep-dive worker error:", error); }
  finally {
    busy = false;
    if (shuttingDown || (ONCE && did)) { db.close(); process.exit(0); }
  }
}
const interval = setInterval(() => { if (!shuttingDown) void tick(); }, POLL_MS);
function shutdown(signal: string) {
  console.log(`Received ${signal}; stopping deep-dive worker...`);
  shuttingDown = true; clearInterval(interval);
  if (!busy) { db.close(); process.exit(0); }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
console.log("Second Brain deep-dive worker started");
void tick();
