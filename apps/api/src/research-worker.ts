import Database from "better-sqlite3";
import { embedTexts, generateResponse } from "./ai.js";
import { liveFetch, runResearch, searxngSearch, type Idea } from "./research.js";
import { createResearchJobStore, MAX_ATTEMPTS, type ResearchJob } from "./research-jobs.js";

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const POLL_MS = 5000;
const store = createResearchJobStore(db);
const search = searxngSearch();

async function processJob(job: ResearchJob) {
  try {
    const { ideaId } = JSON.parse(job.payload) as { ideaId: string };
    const idea = db.prepare(`SELECT id, title, content FROM ideas WHERE id = ?`).get(ideaId) as Idea | undefined;
    if (!idea) throw new Error("Idea not found");
    console.log(`Researching: ${idea.title}`);

    const { findings, checked, dropped, result } = await runResearch(db, idea, {
      search, fetch: liveFetch, embed: texts => embedTexts(texts), llm: generateResponse,
      log: m => console.log(`  ${m}`), stillOwned: () => store.owns(job)
    });
    for (const c of checked) console.log(`  ${c.outcome} (${c.rating === "unchecked" ? "unchecked" : `support=${c.rating.supported}, answers=${c.rating.answers}`}): ${JSON.stringify(c.claim).slice(0, 160)}`);
    for (const d of dropped) console.log(`  dropped (${d.reason}): ${JSON.stringify(d.quote).slice(0, 160)}`);

    const full = store.complete(job, ideaId, findings, result);
    console.log(`Completed ${job.id}: ${JSON.stringify(full)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { owned, retry, delay } = store.fail(job, message);
    if (!owned) { console.warn(`Job ${job.id} is no longer owned by this worker; result discarded.`); return; }
    console.error(`Job ${job.id} failed (${job.attempts}/${MAX_ATTEMPTS}): ${message}`);
    if (retry) console.log(`Retry scheduled in ${Math.round(delay / 1000)} seconds`);
  }
}

let busy = false;
let shuttingDown = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const job = store.claim();
    if (job) await processJob(job);
  } catch (error) {
    console.error("Research worker error:", error);
  } finally {
    busy = false;
    if (shuttingDown) { db.close(); process.exit(0); }
  }
}

const interval = setInterval(() => { if (!shuttingDown) void tick(); }, POLL_MS);

function shutdown(signal: string) {
  console.log(`Received ${signal}; stopping worker...`);
  shuttingDown = true;
  clearInterval(interval);
  if (!busy) { db.close(); process.exit(0); }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("Second Brain research worker started");
void tick();
