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

// The model occasionally misspells a score key (seen: "novelity"); map known variants. Never overrides a correct key.
const KEY_ALIASES: Record<string, string> = { novelity: "novelty", feasability: "feasibility", relevence: "relevance", relavance: "relevance" };
function normalizeKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [bad, good] of Object.entries(KEY_ALIASES)) {
    if (bad in out && !(good in out)) { out[good] = out[bad]; delete out[bad]; }
  }
  return out;
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
  const startedAt = Date.now();

  const raw = await generateResponse([
    {
      role: "system",
      content: `You evaluate proposed ideas of any kind (software, hardware, research, business, personal, or other).

Return ONLY one valid JSON object with these fields, in this order:

- "feasibility_reason": one sentence: main reason and biggest risk for feasibility
- "feasibility": integer 1-5
- "cost_reason": one sentence: main reason and biggest risk for cost
- "cost": integer 1-5
- "relevance_reason": one sentence for relevance
- "relevance": integer 1-5
- "novelty_reason": one sentence for novelty
- "novelty": integer 1-5
- "summary": non-empty string explaining the evaluation
- "requirements": array of strings describing implementation requirements
- "limitations": array of strings describing limitations
- "claims": array of objects {"claim": string, "status": "unverified" | "needs_external_evidence", "reason": string}

SCORE ANCHORS (pick the anchor that best matches; use the whole range):

Feasibility (5 = easiest):
1 = Requires breakthroughs, unavailable resources, or a large team for years
2 = Major unsolved parts; months of specialist work with uncertain outcome
3 = Clear path but substantial work: several weeks, multiple components or integrations
4 = A few days to two weeks for one developer using known tools
5 = A few hours to a weekend with existing tools or libraries

Cost (5 = MOST EXPENSIVE; a higher cost score means MORE money/resources needed):
1 = Essentially free: existing equipment, free software, no ongoing fees
2 = Under about $50 or small free-tier usage
3 = About $50-$500, or modest recurring fees
4 = About $500-$5,000, or significant recurring service costs
5 = Over $5,000, specialised equipment, staff, or infrastructure

Relevance (5 = strongest fit):
1 = Solves no clear problem for anyone identifiable
2 = Nice-to-have; problem is rare or minor
3 = Useful for a real but narrow need
4 = Solves a frequent, clearly felt problem for its intended users
5 = Directly addresses a pressing, high-value need stated in the idea

Novelty (5 = most distinctive):
1 = Many existing products/solutions already do exactly this
2 = Small variation on a common solution
3 = Familiar parts combined in a somewhat distinctive way
4 = Uncommon approach; few known examples
5 = No known equivalent; genuinely new approach

CALIBRATION EXAMPLES (scores only; not related to the idea you evaluate):
- "Script that renames my photo files by date taken": feasibility 5, cost 1, relevance 3, novelty 1
- "Mobile app for a local sports league to schedule games and track standings": feasibility 3, cost 3, relevance 4, novelty 2
- "Desktop fusion reactor for home electricity": feasibility 1, cost 5, relevance 4, novelty 5

RULES:
- Score each dimension independently from its own anchors; the scores do not need to be similar to each other.
- Do not default to the same scores for every idea. Do not avoid 1 or 5 when the anchor fits.
- Base scores on the idea as described. Do not assume any particular hardware, platform, or domain unless the idea names it.
- The user is comfortable with software development.
- Identify missing dependencies (tools, data, skills, equipment, services).
- Do not invent capabilities, studies, test results, sources, or performance statistics; treat such claims as unverified.
- Do not claim that internet research was performed.
- Return valid JSON only: no markdown, code fences, or text outside the JSON object.
- Keep the evaluation concise.`
    },
    {
      role: "user",
      content: `Evaluate this idea and return the evaluation JSON object (feasibility_reason, feasibility, cost_reason, cost, relevance_reason, relevance, novelty_reason, novelty, summary, requirements, limitations, claims). Do not repeat the input.

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
    numPredict: 1600,
    // EVAL_MODEL overrides the scorer; unset keeps generateResponse's default model.
    ...(process.env.EVAL_MODEL ? { model: process.env.EVAL_MODEL } : {}),
    // Prompt with anchors + examples exceeds the 2048 default context.
    numCtx: 4096
  });

  console.log("\n--- RAW MODEL RESPONSE ---");
  console.log(JSON.stringify(raw));
  console.log("--- END MODEL RESPONSE ---\n");

  const evaluation = EvaluationSchema.parse(
    normalizeKeys(extractJson(raw))
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

  console.log(`Evaluated: ${idea.title} (${process.env.EVAL_MODEL ?? "default model"}, ${Date.now() - startedAt} ms)`);
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

