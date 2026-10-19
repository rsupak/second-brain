import Database from "better-sqlite3";
import { generateResponse } from "./ai.js";
import { parseBranches } from "./expansion-parse.js";
import type { Idea } from "./ideas.js";
import {
  MAX_ATTEMPTS,
  createExpansionJobStore,
  type Branch,
  type ExpansionJob
} from "./expansion-jobs.js";

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const POLL_MS = 5000;

const store = createExpansionJobStore(db);

async function expand(idea: Idea): Promise<Branch[]> {
  const level = idea.depth === 0
    ? "secondary"
    : "tertiary";

  const raw = await generateResponse([
    {
      role: "system",
      content: `You are an idea development agent.
Develop exactly three distinct, practical ${level} ideas.
Consider feasibility, constraints, benefits, and novelty.
Return ONLY a JSON object with an "ideas" array of exactly three objects:
{"ideas":[{"title":"...","explanation":"..."}, ...]}
No markdown, no additional commentary.`
    },
    {
      role: "user",
      content: `Original concept: ${idea.title}

Details: ${idea.content}

Develop three useful ${level} ideas.`
    }
  ], { format: "json" });

  return parseBranches(raw);
}

async function processJob(job: ExpansionJob) {
  try {
    const payload = JSON.parse(job.payload) as {
      ideaId: string
    };

    const idea = store.getIdea(payload.ideaId);

    if (!idea) throw new Error("Idea not found");
    if (idea.depth >= 2) {
      throw new Error("Cannot expand a tertiary idea");
    }

    // If a previous attempt already saved children, skip the model call.
    // complete() re-checks inside its transaction, so children are never duplicated.
    const branches = store.childCount(idea.id) > 0
      ? null
      : await expand(idea);

    const count = store.complete(job, idea, branches);

    console.log(`Completed ${job.id}: ${count} branches`);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);

    const { owned, retry, delay } = store.fail(job, message);

    if (!owned) {
      console.warn(
        `Job ${job.id} is no longer owned by this worker; result discarded.`
      );
      return;
    }

    console.error(`Job ${job.id} failed (${job.attempts}/${MAX_ATTEMPTS}): ${message}`);

    if (retry) {
      console.log(`Retry scheduled in ${Math.round(delay / 1000)} seconds`);
    }
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
    console.error("Worker error:", error);
  } finally {
    busy = false;

    if (shuttingDown) {
      db.close();
      process.exit(0);
    }
  }
}

const interval = setInterval(() => {
  if (!shuttingDown) {
    void tick();
  }
}, POLL_MS);

function shutdown(signal: string) {
  console.log(`Received ${signal}; stopping worker...`);

  shuttingDown = true;
  clearInterval(interval);

  // Do not close SQLite while an expansion is still saving.
  if (!busy) {
    db.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("Second Brain idea worker started");
void tick();
