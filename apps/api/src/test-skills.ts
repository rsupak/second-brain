// Skills tests: migration idempotency, unit helpers, deep_dive job ownership, versioning, mocked deep dive
// (fake search/fetch/embed/llm, no network/model), and routes via app.inject (with the cross-site guard).
// Runs ONLY on a copy: sqlite3 data/brain.sqlite ".backup /tmp/brain-skills.sqlite" && BRAIN_DB=/tmp/brain-skills.sqlite npx tsx apps/api/src/test-skills.ts
import Fastify from "fastify";
import Database from "better-sqlite3";
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sha256, verifyQuote, type FetchResult } from "./research-sources.js";
import { LIMITS, type ChatMessage, type ResearchDeps } from "./research.js";
import { ensureSkillTables, skillState } from "./skills-schema.js";
import { createSkillStore, ActiveDeepDiveError, SkillExistsError, LeaseLostError } from "./skill-jobs.js";
import { checkCitations, buildSections, withDeepLimits, runDeepDive, DEEP_LIMITS } from "./deep-dive.js";
import { skillsRoutes, clusterTopics } from "./skills-routes.js";
import { addCrossSiteGuard } from "./security.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) {
  console.error("Refusing: set BRAIN_DB to an existing copy (not ./data/brain.sqlite)"); process.exit(2);
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)); }
}
const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const counts = () => Object.fromEntries(["ideas", "jobs", "research_findings", "research_sources", "research_chunks", "idea_evaluations", "evaluation_jobs", "memories"].map(t => [t, n(`SELECT COUNT(*) n FROM ${t}`)]));
const before = counts();

// ---------- migration ----------
ensureSkillTables(db); ensureSkillTables(db);
const st = skillState(db);
check("migration idempotent: all 6 skill tables exist (run twice)", Object.values(st).every(v => v !== null), st);
check("migration did not change existing tables", JSON.stringify(counts()) === JSON.stringify(before), { before, after: counts() });

// ---------- unit ----------
const cc = checkCitations("A [F1] b [F7] c [F2].", 2);
check("checkCitations keeps valid, strips invalid", cc.text === "A [F1] b c [F2]." && cc.removed === 1 && cc.cited.join() === "1,2", cc);
const bs = buildSections(null, [], ["Q1?"], { ideas: [], skills: [] });
check("buildSections without facts: no invented prose, key facts empty, unanswered question listed",
  bs.sections.find(s => s.key === "key_facts")!.items!.length === 0 && bs.sections.find(s => s.key === "open_questions")!.items![0] === "Q1?"
  && /No verified facts/.test(bs.sections[0]!.text!));
check("section kinds: only key_facts verified; prose is synthesis; related computed",
  bs.sections.map(s => `${s.key}:${s.kind}`).join() === "overview:synthesis,how_it_works:synthesis,key_facts:verified,practical_steps:synthesis,open_questions:synthesis,related:computed");
const savedQ = LIMITS.maxQueries;
let inside = 0;
await withDeepLimits(async () => { inside = LIMITS.maxQueries; });
check("withDeepLimits raises then restores LIMITS", inside === DEEP_LIMITS.maxQueries && LIMITS.maxQueries === savedQ, { inside, after: LIMITS.maxQueries });
try { await withDeepLimits(async () => { throw new Error("x"); }); } catch { /* expected */ }
check("withDeepLimits restores after a throw", LIMITS.maxQueries === savedQ && LIMITS.maxFindings === 8);
const v = (a: number[]) => Float32Array.from(a);
const topics = clusterTopics([{ id: "a", tags: ["baking"], vec: v([1, 0]) }, { id: "b", tags: ["baking", "yeast"], vec: v([0.95, 0.1]) }, { id: "c", tags: ["radio"], vec: v([0, 1]) }, { id: "d", tags: [], vec: null }]);
check("clusterTopics groups similar skills, labels by common tag", topics.get("a") === "baking" && topics.get("b") === "baking" && topics.get("c") === "radio" && topics.get("d") === "uncategorized", Object.fromEntries(topics));

// ---------- fakes for a mocked deep dive ----------
const PAGES: Record<string, string> = {
  "https://bake.example/starter": "A sourdough starter is a culture of wild yeast and bacteria. Starter activity rises with temperature. Feeding the starter flour and water keeps it alive.",
  "https://bake.example/temp": "Sourdough yeast is most active near 26 degrees Celsius. Cold temperature slows the starter. Whole grain flour feeds yeast faster.",
  "https://wiki.example/sourdough": "Sourdough bread uses a starter instead of commercial yeast. The flour type changes sourdough flavor."
};
const fetchFake = (url: string): Promise<FetchResult> => {
  const text = PAGES[url]; const base = { url, final_url: url, title: `T ${url}`, content_type: "text/plain", fetched_at: Date.now() };
  return Promise.resolve(text ? { ...base, http_status: 200, text, content_hash: sha256(text), error: null } : { ...base, http_status: 404, text: null, content_hash: null, error: "HTTP 404" });
};
const searchFake = (_q: string) => Promise.resolve(Object.keys(PAGES).map(url => ({ url, title: url })));
const KEYS = ["sourdough", "starter", "yeast", "temperature", "flour"];
const embedFake = (texts: string[]) => Promise.resolve(texts.map(t => KEYS.map(k => (t.toLowerCase().split(k).length - 1) + 0.01)));
const prompts: Record<string, string> = {};
let writeupMode: "good" | "bad" = "good";
const llmFake = (messages: ChatMessage[]): Promise<string> => {
  const sys = messages[0]!.content, user = messages[1]?.content ?? "";
  if (sys.includes("open questions the idea depends on")) { prompts.questions = sys;
    return Promise.resolve(JSON.stringify({ questions: ["How does sourdough starter yeast work?", "What temperature suits sourdough starter yeast?", "Which flour feeds sourdough starter yeast?",
      "How is sourdough starter yeast fed with flour?", "Does temperature change sourdough starter?", "What is a sourdough starter made of?", "How does flour change sourdough?", "Does cold temperature slow sourdough yeast?", "What does sourdough yeast need?"] })); }
  if (sys.includes("write web search queries")) return Promise.resolve(JSON.stringify({ queries: ["sourdough starter", "starter temperature", "sourdough flour"] }));
  if (sys.includes("judge only whether the QUOTE supports")) {
    const k = (user.match(/ITEM \d+/g) ?? []).length;
    return Promise.resolve(JSON.stringify({ results: Array.from({ length: k }, (_, i) => ({ index: i + 1, supported: "yes", subject: "sourdough" })) }));
  }
  if (sys.includes("extract evidence")) { prompts.synth = sys;
    const ex = [...user.matchAll(/\[(\d+)\] \([^)]*\)\n([^\n]+)/g)];
    const findings = ex.map(m => { const first = m[2]!.split(/(?<=\.)\s/)[0]!; return { claim: first.replace(/\.$/, ""), quote: first, chunk: Number(m[1]) }; });
    findings.push({ claim: "Sourdough starter yeast cures every disease", quote: "Sourdough starter yeast cures every disease.", chunk: 1 });   // not verbatim -> dropped
    return Promise.resolve(JSON.stringify({ findings }));
  }
  if (sys.includes("study guide")) { prompts.writeup = user;
    if (writeupMode === "bad") return Promise.resolve("not json at all");
    return Promise.resolve(JSON.stringify({ summary: "How sourdough starters work.", overview: "A starter is a yeast culture [F1]. It is famous on Mars [F42].",
      how_it_works: "Yeast activity depends on temperature [F2].", practical_steps: ["Feed the starter daily [F1]", "Keep it warm"], open_questions: ["How long can a starter be stored?"], tags: ["Baking", "fermentation"] }));
  }
  return Promise.reject(new Error(`unexpected prompt: ${sys.slice(0, 60)}`));
};
const deps: ResearchDeps = { search: searchFake, fetch: fetchFake, embed: embedFake, llm: llmFake as ResearchDeps["llm"] };

// ---------- store + mocked deep dive ----------
const store = createSkillStore(db);
const idea = db.prepare(`SELECT id, title, content FROM ideas WHERE parent_id IS NULL AND id NOT IN (SELECT idea_id FROM skills) ORDER BY created_at LIMIT 1`).get() as { id: string; title: string; content: string };
const created = store.create(idea.id);
check("create: skill + pending deep_dive job (version 1)", n("SELECT COUNT(*) n FROM jobs WHERE id = ? AND type = 'deep_dive' AND status = 'pending'", created.jobId) === 1 && created.version === 1);
try { store.create(idea.id); check("create twice while active -> ActiveDeepDiveError", false); } catch (e) { check("create twice while active -> ActiveDeepDiveError", e instanceof ActiveDeepDiveError); }
try { store.refresh(created.skillId); check("refresh while active -> ActiveDeepDiveError", false); } catch (e) { check("refresh while active -> ActiveDeepDiveError", e instanceof ActiveDeepDiveError); }

// Only claim deep_dive jobs (other job types untouched)
const otherPendingBefore = n("SELECT COUNT(*) n FROM jobs WHERE type != 'deep_dive' AND status = 'pending'");
const job = store.claim()!;
check("claim: running, owner set, skill status running", !!job && n("SELECT COUNT(*) n FROM jobs WHERE id = ? AND status='running' AND lease_owner = ?", job.id, job.lease_owner) === 1
  && (db.prepare("SELECT status FROM skills WHERE id = ?").pluck().get(created.skillId) === "running"));
check("claim did not touch other job types", n("SELECT COUNT(*) n FROM jobs WHERE type != 'deep_dive' AND status = 'pending'") === otherPendingBefore);

const res = await runDeepDive(db, created.skillId, { ...idea, title: "Sourdough starter care", content: "Keep a sourdough starter healthy: yeast, flour and temperature." }, deps);
check("deep limits used: question prompt asks for 8 to 10", /List the 8 to 10 most important/.test(prompts.questions ?? ""), prompts.questions?.slice(0, 120));
check("deep limits used: synthesis allows 16 findings", /At most 16 findings/.test(prompts.synth ?? ""));
check("LIMITS restored after deep dive (3 to 5 / 8 findings)", LIMITS.maxQueries === 5 && LIMITS.minQuestions === 3 && LIMITS.maxFindings === 8);
const kf = res.sections.find(s => s.key === "key_facts")!.items as Array<{ claim: string; quote: string; url: string }>;
check("key facts > 0 and every key-fact quote is verbatim in its source chunk", kf.length > 0 && res.findings.every(f =>
  verifyQuote((db.prepare("SELECT text FROM research_chunks WHERE id = ?").pluck().get(f.chunk_id) as string), f.quote)), { kf: kf.length });
check("invented (non-verbatim) claim not in key facts", !kf.some(f => /every disease/.test(f.claim)));
check("write-up prompt contains only numbered facts", /VERIFIED FACTS:\n\[F1\]/.test(prompts.writeup ?? ""));
const ov = res.sections.find(s => s.key === "overview")!;
check("citation to a nonexistent fact removed", !ov.text!.includes("[F42]") && ov.text!.includes("[F1]") && res.stats.removedCitations === 1, ov.text);
check("tags lowercased", res.tags.join() === "baking,fermentation");
check("sources linked to existing research_sources", res.sources.length > 0 && res.sources.every(s => n("SELECT COUNT(*) n FROM research_sources WHERE id = ?", s.source_id) === 1));
check("stats include duration + section lengths", typeof res.stats.total_ms === "number" && typeof (res.stats.sectionChars as any).overview === "number");

const done = store.complete(job, res);
check("complete: version 1 stored, skill ready", done.version === 1 && db.prepare("SELECT status || ':' || version FROM skills WHERE id = ?").pluck().get(created.skillId) === "ready:1");
check("complete: findings stored with version", n("SELECT COUNT(*) n FROM skill_findings WHERE skill_id = ? AND version = 1", created.skillId) === res.findings.length);
check("research_findings untouched by deep dive", n("SELECT COUNT(*) n FROM research_findings") === before.research_findings);
try { store.create(idea.id); check("create after done -> SkillExistsError", false); } catch (e) { check("create after done -> SkillExistsError", e instanceof SkillExistsError); }

// Refresh -> version 2, version 1 kept; lease loss is refused
const ref = store.refresh(created.skillId);
check("refresh queues version 2", ref.version === 2);
const job2 = store.claim()!;
db.prepare("UPDATE jobs SET lease_owner = 'someone-else' WHERE id = ?").run(job2.id);
try { store.complete(job2, res); check("complete with lost lease -> LeaseLostError", false); } catch (e) { check("complete with lost lease -> LeaseLostError", e instanceof LeaseLostError); }
check("lost lease wrote nothing", n("SELECT COUNT(*) n FROM skill_versions WHERE skill_id = ?", created.skillId) === 1);
check("fail with lost lease is not owned", store.fail(job2, "x").owned === false);
db.prepare("UPDATE jobs SET lease_owner = ? WHERE id = ?").run(job2.lease_owner, job2.id);
writeupMode = "bad";
let writeErr = "";
try { await runDeepDive(db, created.skillId, { ...idea, title: "Sourdough starter care", content: "yeast flour temperature sourdough starter" }, deps); } catch (e) { writeErr = String(e); }
check("invalid write-up JSON -> error (no partial version)", /Write-up failed/.test(writeErr), writeErr);
const f2 = store.fail(job2, writeErr);
check("fail: retry scheduled, skill back to pending, old version still current", f2.owned && f2.retry && db.prepare("SELECT status || ':' || version FROM skills WHERE id = ?").pluck().get(created.skillId) === "pending:1");
writeupMode = "good";
db.prepare("UPDATE jobs SET run_after = 0 WHERE id = ?").run(job2.id);
const job3 = store.claim()!;
store.complete(job3, await runDeepDive(db, created.skillId, { ...idea, title: "Sourdough starter care", content: "yeast flour temperature sourdough starter" }, deps));
check("refresh completes as version 2; version 1 kept", n("SELECT COUNT(*) n FROM skill_versions WHERE skill_id = ?", created.skillId) === 2 && db.prepare("SELECT version FROM skills WHERE id = ?").pluck().get(created.skillId) === 2);

// ---------- routes ----------
const app = Fastify({ logger: false });
addCrossSiteGuard(app);
await app.register(skillsRoutes, { db });
await app.ready();
const H = { origin: "http://127.0.0.1:3333", "sec-fetch-site": "same-origin" };
let r = await app.inject({ method: "POST", url: "/ideas/does-not-exist/skill", headers: H });
check("POST /ideas/:id/skill unknown -> 404", r.statusCode === 404, r.body);
const idea2 = db.prepare(`SELECT id FROM ideas WHERE id NOT IN (SELECT idea_id FROM skills) ORDER BY created_at LIMIT 1`).get() as { id: string };
r = await app.inject({ method: "POST", url: `/ideas/${idea2.id}/skill`, headers: H });
const b = r.json();
check("POST /ideas/:id/skill -> 202 with skillId/jobId/version", r.statusCode === 202 && typeof b.skillId === "string" && typeof b.jobId === "string" && b.version === 1, b);
r = await app.inject({ method: "POST", url: `/ideas/${idea2.id}/skill`, headers: H });
check("POST again while job active -> 409 with activeJobId", r.statusCode === 409 && r.json().activeJobId === b.jobId, r.body);
r = await app.inject({ method: "POST", url: `/ideas/${idea.id}/skill`, headers: H });
check("POST for idea that already has a ready skill -> 409 with skillId", r.statusCode === 409 && r.json().skillId === created.skillId, r.body);
r = await app.inject({ method: "POST", url: `/ideas/${idea2.id}/skill`, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
check("cross-site POST -> 403", r.statusCode === 403);
r = await app.inject({ method: "POST", url: `/skills/${b.skillId}/refresh`, headers: H });
check("POST /skills/:id/refresh while active -> 409", r.statusCode === 409);
r = await app.inject({ method: "POST", url: `/skills/nope/refresh`, headers: H });
check("POST /skills/:id/refresh unknown -> 404", r.statusCode === 404);
r = await app.inject({ method: "POST", url: `/skills/${created.skillId}/refresh`, headers: H });
check("POST /skills/:id/refresh -> 202 version 3", r.statusCode === 202 && r.json().version === 3, r.body);
r = await app.inject({ method: "GET", url: "/skills" });
const list = r.json();
check("GET /skills lists both, with topic/facts/latestJob", r.statusCode === 200 && list.length === 2 && list.every((s: any) => "topic" in s && "facts" in s && "latestJob" in s), list);
r = await app.inject({ method: "GET", url: "/skills?q=fermentation" });
check("GET /skills?q= matches tags", r.json().length === 1 && r.json()[0].id === created.skillId, r.json());
r = await app.inject({ method: "GET", url: "/skills?q=zzzz_no_match%25" });
check("GET /skills?q= no match (LIKE wildcards escaped)", r.statusCode === 200 && r.json().length === 0);
r = await app.inject({ method: "GET", url: `/skills/${created.skillId}` });
const d = r.json();
check("GET /skills/:id full content: 6 sections, findings with urls, sources, 2 versions, parent idea",
  r.statusCode === 200 && d.sections.length === 6 && d.findings.length > 0 && d.findings.every((f: any) => /^https:/.test(f.url)) && d.sources.length > 0 && d.versions.length === 2 && d.idea.id === idea.id && d.viewVersion === 2, { s: r.statusCode, v: d.versions, vv: d.viewVersion });
r = await app.inject({ method: "GET", url: `/skills/${created.skillId}?version=1` });
check("GET /skills/:id?version=1 returns old version", r.statusCode === 200 && r.json().viewVersion === 1);
r = await app.inject({ method: "GET", url: `/skills/${created.skillId}?version=9` });
check("GET unknown version -> 404", r.statusCode === 404);
r = await app.inject({ method: "GET", url: `/skills/nope` });
check("GET /skills/:id unknown -> 404", r.statusCode === 404);
r = await app.inject({ method: "GET", url: `/ideas/${idea2.id}/skill` });
check("GET /ideas/:id/skill shows pending skill + job", r.statusCode === 200 && r.json().skill.status === "pending" && r.json().latestJob.status === "pending", r.body);

const after = counts();
check("only ideas count unchanged; jobs grew only by deep_dive jobs", after.ideas === before.ideas && after.jobs - before.jobs === n("SELECT COUNT(*) n FROM jobs WHERE type='deep_dive'"), { before, after });
await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
