import Database from "better-sqlite3";
import { generateResponse } from "./ai.js";
import { EvaluationSchema } from "./evaluations.js";
import {
  MAX_ATTEMPTS,
  createEvaluationJobStore,
  type EvaluationJob
} from "./evaluation-jobs.js";

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const POLL_MS = 5000;

const store = createEvaluationJobStore(db);

type Idea = {
  title: string;
  content: string;
  depth: number;
};

function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error(
      `Model did not return a JSON object. Output: ${raw.slice(0, 300)
      }`
    );
  }

  return JSON.parse(raw.slice(start, end + 1));
}

function detectClaims(content: string): string[] {
  const matches = [
    ...content.matchAll(
      /[^.!?\n]*(?:\d+(?:\.\d+)?\s*%|pilot tests?|studies show|proven to)[^.!?\n]*/gi
    )
  ];

  return [...new Set(
    matches.map(match => match[0].trim()).filter(Boolean)
  )];
}

async function evaluate(job: EvaluationJob) {
  const idea = db.prepare(`
    SELECT title, content, depth
    FROM ideas
    WHERE id = ?
  `).get(job.idea_id) as Idea | undefined;

  if (!idea) throw new Error("Idea not found");

  const flaggedClaims = detectClaims(idea.content);

  const raw = await generateResponse([
    {
      role: "system",
      content: `You evaluate proposed ideas of any kind (software, hardware, research, business, personal, or other).

Return ONLY one valid JSON object.

The JSON object must contain exactly these fields:

- "feasibility": integer from 1 to 5
- "cost": integer from 1 to 5
- "relevance": integer from 1 to 5
- "novelty": integer from 1 to 5
- "summary": non-empty string explaining the evaluation
- "requirements": array of strings describing implementation requirements
- "limitations": array of strings describing technical limitations
- "claims": array of objects containing:
    - "claim": string describing a factual claim requiring verification
    - "status": either "unverified" or "needs_external_evidence"
    - "reason": string explaining why verification is necessary

SCORING CRITERIA:

Feasibility:
1 = Extremely difficult to implement with the resources the idea implies
2 = Significant engineering challenges
3 = Moderate engineering effort
4 = Achievable with some additional development
5 = Straightforward to prototype with available resources

Cost:
1 = Minimal additional expense
2 = Low additional expense
3 = Moderate expense (equipment, services, or time)
4 = Substantial additional expense
5 = Significant expense or infrastructure investment

Relevance:
1 = Weak usefulness for the stated goal
2 = Limited relevance
3 = Somewhat relevant
4 = Strong relevance
5 = Directly useful for the goal the idea describes

Novelty:
1 = Common or widely implemented solution
2 = Minor variation of an existing solution
3 = Some distinctive features
4 = Innovative combination of existing technologies
5 = Highly original or unusual application

IMPORTANT RULES:
- Evaluate each scoring dimension independently.
- Assign scores based on the actual idea as described.
- Do not use default scores.
- Do not automatically assign a score of 1.
- Scores of 1 are valid when justified by the criteria.
- Higher cost scores indicate greater expense.
- Do not invent capabilities, research findings, or performance statistics.
- Treat unsupported performance claims as unverified.
- Include specific requirements and realistic limitations.
- Return valid JSON only.
- Do not include markdown, code fences, explanations outside JSON, or additional fields.

All scores are integers from 1 to 5.
Feasibility: 5 = easiest.
Cost: 5 = most expensive.
Relevance: 5 = strongest fit.
Novelty: 5 = most distinctive.

The user is comfortable with software development.

Do not assume any particular hardware, platform, or domain unless the idea names it.
Identify missing dependencies (tools, data, skills, equipment, services).
Treat performance statistics and research claims as unverified.
Do not invent studies, test results, or sources.
Do not claim that internet research was performed.
Keep the evaluation concise.`
    },
    {
      role: "user",
      content: `Evaluate this idea and return the evaluation JSON object (feasibility, cost, relevance, novelty, summary, requirements, limitations, claims). Do not repeat the input.

Idea: ${JSON.stringify({
        title: idea.title,
        description: idea.content,
        depth: idea.depth,
        automatically_flagged_claims: flaggedClaims
      })}`
    }
  ], {
    format: "json",
    temperature: 0,
    numPredict: 1200
  });

  console.log("\n--- RAW MODEL RESPONSE ---");
  console.log(JSON.stringify(raw));
  console.log("--- END MODEL RESPONSE ---\n");

  const evaluation = EvaluationSchema.parse(
    extractJson(raw)
  );

  // Deterministically preserve claims detected by code,
  // even if the model omits them.
  for (const claim of flaggedClaims) {
    if (!evaluation.claims.some(
      item => item.claim.includes(claim) ||
        claim.includes(item.claim)
    )) {
      evaluation.claims.push({
        claim,
        status: "needs_external_evidence",
        reason: "Contains a numerical or research-based claim without a cited source."
      });
    }
  }


  // Saves the result and completes the job atomically,
  // only if this worker still owns an unexpired lease.
  store.saveResult(job, evaluation);

  console.log(`Evaluated: ${idea.title}`);
}

async function processJob(job: EvaluationJob) {
  try {
    await evaluate(job);
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

    console.error(
      `Evaluation failed (${job.attempts}/${MAX_ATTEMPTS}):`,
      message
    );

    if (retry) {
      console.log(
        `Retry scheduled in ${Math.round(delay / 1000)} seconds`
      );
    }
  }
}

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;

  try {
    const job = store.claim();
    if (job) await processJob(job);
  } catch (error) {
    console.error("Evaluation worker error:", error);
  } finally {
    busy = false;

    if (shuttingDown) {
      db.close();
      process.exit(0);
    }
  }
}


let shuttingDown = false;

const interval = setInterval(() => {
  if (!shuttingDown) {
    void tick();
  }
}, POLL_MS);

function shutdown(signal: string) {
  console.log(`Received ${signal}; stopping worker...`);

  shuttingDown = true;
  clearInterval(interval);

  // Do not close SQLite while an evaluation
  // is still saving its results.
  if (!busy) {
    db.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("Second Brain evaluation worker started");
void tick();

