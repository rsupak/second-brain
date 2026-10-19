// Tests auto-queue of evaluation + research on POST /ideas via app.inject on a BRAIN_DB copy. Refuses the real DB.
// Usage: sqlite3 data/brain.sqlite ".backup /tmp/brain-auto.sqlite" && BRAIN_DB=/tmp/brain-auto.sqlite SECOND_BRAIN_NO_LISTEN=1 npx tsx apps/api/src/test-auto-queue.ts
import Database from "better-sqlite3";
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) {
  console.error("Refusing: set BRAIN_DB to an existing copy (not ./data/brain.sqlite)"); process.exit(2);
}
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }
delete process.env.AUTO_EVALUATE; delete process.env.AUTO_RESEARCH;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}

const { app } = await import("./server.js");
const { createIdea } = await import("./ideas.js");
await app.ready();
const db = new Database(dbPath, { readonly: true });
const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const evalJobs = (id: string) => n("SELECT COUNT(*) n FROM evaluation_jobs WHERE idea_id = ?", id);
const resJobs = (id: string) => n("SELECT COUNT(*) n FROM jobs WHERE type = 'research_idea' AND json_extract(payload,'$.ideaId') = ?", id);
const expJobs = (id: string) => n("SELECT COUNT(*) n FROM jobs WHERE type = 'expand_idea' AND json_extract(payload,'$.ideaId') = ?", id);
const post = (title: string) => app.inject({ method: "POST", url: "/ideas", headers: { "content-type": "application/json" }, payload: JSON.stringify({ title, content: "auto queue test" }) });

const evalBefore = n("SELECT COUNT(*) n FROM idea_evaluations");

// Default on
let r = await post("auto default");
let b = r.json();
check("default: 201", r.statusCode === 201, r.body);
check("default: backward-compatible fields idea + jobId", typeof b.idea?.id === "string" && typeof b.jobId === "string", b);
check("default: evaluationJobId + researchJobId returned", typeof b.evaluationJobId === "string" && typeof b.researchJobId === "string", b);
check("default: 1 eval job, 1 research job, 1 expansion job in DB", evalJobs(b.idea.id) === 1 && resJobs(b.idea.id) === 1 && expJobs(b.idea.id) === 1);

// Off
process.env.AUTO_EVALUATE = "0"; process.env.AUTO_RESEARCH = "0";
r = await post("auto off"); b = r.json();
check("off: 201, no extra fields", r.statusCode === 201 && !("evaluationJobId" in b) && !("researchJobId" in b), b);
check("off: no eval/research jobs, expansion still queued", evalJobs(b.idea.id) === 0 && resJobs(b.idea.id) === 0 && expJobs(b.idea.id) === 1);

// Mixed
process.env.AUTO_EVALUATE = "1"; process.env.AUTO_RESEARCH = "0";
r = await post("auto eval only"); b = r.json();
check("eval only: eval job, no research job", evalJobs(b.idea.id) === 1 && resJobs(b.idea.id) === 0 && typeof b.evaluationJobId === "string" && !("researchJobId" in b), b);
delete process.env.AUTO_EVALUATE; delete process.env.AUTO_RESEARCH;

// Child ideas created the way the worker does (createIdea with parent) get nothing auto-queued
const parentId = (await post("auto parent")).json().idea.id as string;
const child = createIdea("child", "worker child", parentId, "expansion");
check("child idea: no eval/research jobs", evalJobs(child.id) === 0 && resJobs(child.id) === 0);

check("no existing evaluations touched", n("SELECT COUNT(*) n FROM idea_evaluations") === evalBefore);

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
