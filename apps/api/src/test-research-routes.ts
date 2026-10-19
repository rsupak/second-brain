// Tests for research-routes.ts via app.inject on a BRAIN_DB copy. Refuses the real DB.
// Usage: sqlite3 data/brain.sqlite ".backup /tmp/brain-test.sqlite" && BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-research-routes.ts

import Fastify from "fastify";
import Database from "better-sqlite3";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { researchRoutes } from "./research-routes.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) {
  console.error("Refusing: set BRAIN_DB to an existing copy (not ./data/brain.sqlite)"); process.exit(2);
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}

const app = Fastify({ logger: false });
// Unreachable probe targets: port 9 on loopback refuses immediately.
await app.register(researchRoutes, { db, searxngUrl: "http://127.0.0.1:9", ollamaUrl: "http://127.0.0.1:9", probeTimeoutMs: 500 });
const live = Fastify({ logger: false });
await live.register(researchRoutes, { db });
await app.ready(); await live.ready();

const get = (url: string, a = app) => a.inject({ method: "GET", url });
const idea = db.prepare(`SELECT id FROM ideas WHERE id IN (SELECT idea_id FROM research_findings) LIMIT 1`).get() as { id: string } | undefined
  ?? db.prepare(`SELECT id FROM ideas LIMIT 1`).get() as { id: string };
const freeIdea = db.prepare(`SELECT id FROM ideas WHERE id NOT IN (SELECT json_extract(payload,'$.ideaId') FROM jobs WHERE type='research_idea') LIMIT 1`).get() as { id: string };
const totalFindings = (db.prepare(`SELECT COUNT(*) n FROM research_findings`).get() as { n: number }).n;

// /research/findings
let r = await get("/research/findings");
check("GET /research/findings 200 array, count matches table", r.statusCode === 200 && r.json().length === Math.min(totalFindings, 500), { s: r.statusCode, n: r.json().length, totalFindings });
r = await get(`/research/findings?ideaId=${idea.id}`);
const fs1 = r.json();
check("findings filtered by ideaId", r.statusCode === 200 && fs1.every((f: any) => f.idea_id === idea.id));
if (fs1.length) check("finding has claim, quote, url, title, sourceType, site, created_at",
  ["claim", "quote", "url", "title", "sourceType", "site", "created_at"].every(k => k in fs1[0]), fs1[0]);
else console.log("NOTE  copy has no findings; field-shape check skipped");
r = await get(`/research/findings?ideaId=`);
check("findings with empty ideaId -> 400", r.statusCode === 400);

// /ideas/:id/research
r = await get(`/ideas/${idea.id}/research`);
const ir = r.json();
check("GET /ideas/:id/research 200 with idea, findings, sources, latestJob", r.statusCode === 200 && ir.idea?.id === idea.id && Array.isArray(ir.findings) && Array.isArray(ir.sources) && "latestJob" in ir, Object.keys(ir));
if (ir.latestJob) check("latestJob.result parsed JSON", typeof ir.latestJob.result === "object");
r = await get(`/ideas/does-not-exist/research`);
check("GET /ideas/unknown/research -> 404", r.statusCode === 404);

// /research/jobs
r = await get("/research/jobs");
check("GET /research/jobs 200 array with fields", r.statusCode === 200 && Array.isArray(r.json()) &&
  r.json().every((j: any) => ["id", "ideaId", "status", "attempts", "error", "created_at", "completed_at", "resultCounts"].every(k => k in j)), r.json()[0]);
r = await get("/research/jobs?status=completed");
check("GET /research/jobs?status=completed filters", r.statusCode === 200 && r.json().every((j: any) => j.status === "completed"));
r = await get("/research/jobs?status=bogus");
check("GET /research/jobs?status=bogus -> 400", r.statusCode === 400);

// POST /ideas/:id/research
r = await app.inject({ method: "POST", url: "/ideas/does-not-exist/research" });
check("POST unknown idea -> 404", r.statusCode === 404);
const before = (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='research_idea'`).get() as { n: number }).n;
r = await app.inject({ method: "POST", url: `/ideas/${freeIdea.id}/research` });
const jobId = r.json().jobId;
check("POST idea -> 202 with job id, job row pending", r.statusCode === 202 && typeof jobId === "string" &&
  (db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(jobId) as any)?.status === "pending", r.json());
r = await app.inject({ method: "POST", url: `/ideas/${freeIdea.id}/research` });
check("POST again while active -> 409 with activeJobId", r.statusCode === 409 && r.json().activeJobId === jobId, r.json());
check("exactly one job added", (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type='research_idea'`).get() as { n: number }).n === before + 1);

// /status
r = await get("/status");
const st = r.json();
check("GET /status shape", r.statusCode === 200 && Array.isArray(st.jobs) && Array.isArray(st.evaluationJobs) && Array.isArray(st.inferenceLock) && "held" in (st.inferenceLock[0] ?? { held: 0 }), Object.keys(st));
check("/status reports unreachable probes (no throw)", st.searxng.reachable === false && st.ollama.reachable === false, { s: st.searxng, o: st.ollama });
check("/status shows the new pending research job", st.jobs.some((j: any) => j.type === "research_idea" && j.status === "pending" && j.count >= 1));
r = await get("/status", live);
console.log(`INFO  live probes: searxng=${JSON.stringify(r.json().searxng)} ollama=${JSON.stringify(r.json().ollama)}`);

// static allowlist
r = await get("/");
check("GET / -> index.html text/html", r.statusCode === 200 && r.headers["content-type"]!.toString().startsWith("text/html") && r.body.includes("<title>Second Brain</title>"));
r = await get("/dashboard/app.js");
check("GET /dashboard/app.js text/javascript", r.statusCode === 200 && r.headers["content-type"]!.toString().startsWith("text/javascript"));
r = await get("/dashboard/styles.css");
check("GET /dashboard/styles.css text/css", r.statusCode === 200 && r.headers["content-type"]!.toString().startsWith("text/css"));
for (const u of ["/dashboard/../package.json", "/dashboard/%2e%2e/%2e%2e/package.json", "/dashboard/..%2f..%2fpackage.json", "/dashboard/index.html", "/dashboard/other.js", "/index.html", "/dashboard/app.js/../../package.json"]) {
  r = await get(u);
  check(`traversal/non-allowlisted ${u} -> 404, no file contents`, r.statusCode === 404 && !r.body.includes("\"dependencies\""), r.statusCode);
}
const js = readFileSync(new URL("../../dashboard/app.js", import.meta.url), "utf8");
check("dashboard app.js never uses innerHTML/outerHTML/insertAdjacentHTML", !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
check("dashboard links use rel=noopener noreferrer", js.includes(`rel: "noopener noreferrer"`));
const html = readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8") + js + readFileSync(new URL("../../dashboard/styles.css", import.meta.url), "utf8");
check("no external CDN/fonts referenced", !/https?:\/\/(?!127\.0\.0\.1)/.test(html.replace(/new URL\(url\)/g, "")));

await app.close(); await live.close(); db.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
