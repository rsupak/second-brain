// Model benchmark: re-runs the 13 stored idea evaluations on several models.
// Reads ONLY a copy of the database (BRAIN_DB). Never writes evaluations to any DB;
// results go to /tmp/bench-results.json.
// The system prompt, extractJson, detectClaims and EvaluationSchema are COPIED verbatim
// from evaluation-worker.ts / evaluations.ts (not imported: the worker has no exports and
// evaluations.ts opens the real DB at import time).
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/bench-models.ts

import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createInferenceLock } from "./inference-lock.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

const MODELS = (process.env.BENCH_MODELS ??
  "qwen3:4b,qwen3:4b-instruct-2507-q4_K_M,gemma4:e4b-it-qat,qwen3.5:9b").split(",");
const OUT = process.env.BENCH_OUT ?? "/tmp/bench-results.json";
// BENCH_NO_FORMAT=1 omits format:"json" (for runners without structured output, e.g. MLX).
const NO_FORMAT = process.env.BENCH_NO_FORMAT === "1";

const EvaluationSchema = z.object({
  feasibility: z.number().int().min(1).max(5),
  cost: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  novelty: z.number().int().min(1).max(5),
  summary: z.string().min(1),
  requirements: z.array(z.string()),
  limitations: z.array(z.string()),
  claims: z.array(z.object({
    claim: z.string(),
    status: z.enum([
      "unverified",
      "needs_external_evidence"
    ]),
    reason: z.string()
  }))
});


const SYSTEM_PROMPT = `You evaluate proposed engineering ideas.

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
1 = Extremely difficult to implement with available hardware
2 = Significant engineering challenges
3 = Moderate engineering effort
4 = Achievable with some additional development
5 = Straightforward to prototype with available resources

Cost:
1 = Minimal additional expense
2 = Low additional expense
3 = Moderate hardware or service expense
4 = Substantial additional expense
5 = Significant expense or infrastructure investment

Relevance:
1 = Weak connection to the user's projects
2 = Limited relevance
3 = Somewhat relevant
4 = Strong relevance
5 = Directly supports the LoRa lab or Second Brain

Novelty:
1 = Common or widely implemented solution
2 = Minor variation of an existing solution
3 = Some distinctive features
4 = Innovative combination of existing technologies
5 = Highly original or unusual application

IMPORTANT RULES:
- Evaluate each scoring dimension independently.
- Assign scores based on the actual idea and available hardware.
- Do not use default scores.
- Do not automatically assign a score of 1.
- Scores of 1 are valid when justified by the criteria.
- Higher cost scores indicate greater expense.
- Do not invent hardware capabilities, research findings, or performance statistics.
- Treat unsupported performance claims as unverified.
- Include specific engineering requirements and realistic limitations.
- Return valid JSON only.
- Do not include markdown, code fences, explanations outside JSON, or additional fields.

All scores are integers from 1 to 5.
Feasibility: 5 = easiest.
Cost: 5 = most expensive.
Relevance: 5 = strongest fit.
Novelty: 5 = most distinctive.

Available hardware:
- Apple M2 Mac mini, 16 GB memory
- Two Heltec ESP32-S3 LoRa boards
- Arduino Uno Q

The user is comfortable with software development.

Identify missing hardware and engineering dependencies.
Treat performance statistics and research claims as unverified.
Do not invent studies, test results, or sources.
Do not claim that internet research was performed.
Do not assume the Arduino Uno Q has a LoRa radio.
Do not assume the LoRa network supports mesh routing.
Keep the evaluation concise.`;

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


const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
const lock = createInferenceLock(db);

type Row = { id: string; title: string; content: string; depth: number;
  feasibility: number | null; cost: number | null; relevance: number | null; novelty: number | null };
const ideas = db.prepare(`
  SELECT i.id, i.title, i.content, i.depth, e.feasibility, e.cost, e.relevance, e.novelty
  FROM ideas i LEFT JOIN idea_evaluations e ON e.idea_id = i.id
  ORDER BY i.created_at, i.rowid
`).all() as Row[];

async function chat(model: string, idea: { title: string; content: string; depth: number }) {
  const body = {
    model, stream: false, think: false, ...(NO_FORMAT ? {} : { format: "json" }),
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({
        title: idea.title, description: idea.content, depth: idea.depth,
        automatically_flagged_claims: detectClaims(idea.content) }) }
    ],
    options: { temperature: 0, num_ctx: 8192, num_predict: 1200 }
  };
  return lock.withInferenceLock(async signal => {
    const t0 = Date.now();
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)])
    });
    const text = await res.text();
    const latency = Date.now() - t0;
    if (!res.ok) return { ok: false as const, latency, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    return { ok: true as const, latency, data: JSON.parse(text) as any };
  });
}

const results: any = { started: new Date().toISOString(), db: dbPath, ideas: ideas.length, models: {} };
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 2));

for (const model of MODELS) {
  console.log(`\n=== ${model}`);
  const calls: any[] = [];
  const warm = await chat(model, ideas[0]!);
  const r: any = { warmup_ms: warm.latency, warmup_load_ms: warm.ok ? Math.round((warm.data.load_duration ?? 0) / 1e6) : null, calls };
  results.models[model] = r;
  for (const idea of ideas) {
    const c: any = { idea_id: idea.id, title: idea.title };
    try {
      const out = await chat(model, idea);
      c.latency_ms = out.latency;
      if (!out.ok) throw new Error(out.error);
      const d = out.data;
      const raw = (d.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
      c.done_reason = d.done_reason;
      c.eval_count = d.eval_count; c.prompt_eval_count = d.prompt_eval_count;
      c.gen_tps = d.eval_duration ? d.eval_count / (d.eval_duration / 1e9) : null;
      c.prompt_tps = d.prompt_eval_duration ? d.prompt_eval_count / (d.prompt_eval_duration / 1e9) : null;
      c.load_ms = Math.round((d.load_duration ?? 0) / 1e6);
      let parsed: unknown;
      try { parsed = extractJson(raw); c.json_valid = true; }
      catch (e) { c.json_valid = false; c.error = String(e).slice(0, 300); }
      if (c.json_valid) {
        const v = EvaluationSchema.safeParse(parsed);
        c.schema_pass = v.success && d.done_reason === "stop";
        if (!v.success) c.error = v.error.issues.slice(0, 3).map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
        else if (d.done_reason !== "stop") c.error = `done_reason ${d.done_reason}`;
        if (v.success) {
          c.scores = { feasibility: v.data.feasibility, cost: v.data.cost, relevance: v.data.relevance, novelty: v.data.novelty };
          if (idea.feasibility != null) {
            const stored = { feasibility: idea.feasibility, cost: idea.cost!, relevance: idea.relevance!, novelty: idea.novelty! };
            const diffs = (Object.keys(stored) as (keyof typeof stored)[]).map(k => Math.abs(stored[k] - c.scores[k]));
            c.agreement = { mean_abs_diff: diffs.reduce((a, b) => a + b, 0) / 4,
              exact_fields: diffs.filter(x => x === 0).length, within1_fields: diffs.filter(x => x <= 1).length };
          }
        }
      } else c.schema_pass = false;
    } catch (e) { c.schema_pass = false; c.error = String(e).slice(0, 300); }
    calls.push(c);
    console.log(`${c.schema_pass ? "ok  " : "FAIL"} ${c.latency_ms}ms ${c.gen_tps?.toFixed(1)} tok/s ${idea.title.slice(0, 50)}${c.error ? "  " + c.error.slice(0, 120) : ""}`);
    save();
  }
  try { r.ollama_ps = execSync("ollama ps").toString(); } catch (e) { r.ollama_ps = String(e); }
  console.log(r.ollama_ps);
  await fetch("http://127.0.0.1:11434/api/generate", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0 }) });
  save();
}
results.finished = new Date().toISOString();
save();
db.close();
console.log(`Wrote ${OUT}`);
