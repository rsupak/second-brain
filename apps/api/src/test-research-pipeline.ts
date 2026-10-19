// Research pipeline test with deterministic fake search/fetch/embed/llm. No network, no model.
// Runs ONLY against a copy of the database given by BRAIN_DB.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-research-pipeline.ts

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureResearchTables } from "./research-schema.js";
import { sha256, verifyQuote, type FetchResult } from "./research-sources.js";
import { runResearch, pickCandidates, selectTopChunks, type ResearchDeps, type ChatMessage } from "./research.js";
import { createResearchJobStore, ActiveResearchJobError, LeaseLostError, type ResearchJob } from "./research-jobs.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) throw new Error("Refusing to run against the real database.");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
ensureResearchTables(db);

let failures = 0, total = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

// ---------- fakes ----------
const PAGES: Record<string, string> = {
  "https://a.example/lora": "LoRa radios use chirp spread spectrum modulation. A LoRa sensor node can run for years on a battery when it transmits rarely. Range depends on spreading factor and terrain.",
  "https://b.example/battery": "Battery life of a sensor depends mostly on sleep current. Deep sleep on the ESP32-S3 draws microamps. Transmitting dominates the energy budget.",
  "https://c.example/other": "Gardening tips for tomatoes. Water in the morning. Use mulch."
};
let llmMode: "good" | "garbage" = "good";
let supportMode: "yes" | "partial" | "no" | "bad" | "bad-once" = "yes";
let supportCalls = 0;
const fetchCalls: string[] = [];

function fakeFetch(url: string): Promise<FetchResult> {
  fetchCalls.push(url);
  const text = PAGES[url];
  const base = { url, final_url: url, title: url, content_type: "text/plain", fetched_at: Date.now() };
  return Promise.resolve(text
    ? { ...base, http_status: 200, text, content_hash: sha256(text), error: null }
    : { ...base, http_status: 404, text: null, content_hash: null, error: "HTTP 404" });
}

const fakeSearch = (q: string) => Promise.resolve([
  { url: "https://a.example/lora#section", title: "A" },
  { url: "ftp://files.example/x", title: "ftp" },
  { url: "https://missing.example/404", title: "404" },
  { url: q.length % 2 ? "https://b.example/battery" : "https://c.example/other", title: "B/C" },
  { url: "https://a.example/lora", title: "A dup" }
]);

const KEYS = ["lora", "battery", "sensor", "sleep", "tomato"];
const fakeEmbed = (texts: string[]) => Promise.resolve(texts.map(t => KEYS.map(k => (t.toLowerCase().split(k).length - 1) + 0.01)));

function fakeLlm(messages: ChatMessage[]): Promise<string> {
  const sys = messages[0]!.content;
  if (sys.includes("search queries")) {
    return Promise.resolve(llmMode === "garbage" ? "sure! here are queries: lora, battery"
      : JSON.stringify({ queries: ["LoRa sensor battery life", "ESP32-S3 deep sleep current", "LoRa range"] }));
  }
  if (sys.includes("rate whether each quote supports")) {
    supportCalls++;
    const n = (messages[1]!.content.match(/^ITEM \d+/gm) ?? []).length;
    if (supportMode === "bad" || (supportMode === "bad-once" && supportCalls === 1)) return Promise.resolve("I think they are fine");
    const level = supportMode === "bad-once" ? "yes" : supportMode;
    return Promise.resolve(JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ index: i + 1, supported: level })) }));
  }
  // Synthesis: quote the first sentence of excerpt 1 verbatim, plus a fabricated quote and a bad chunk number.
  const user = messages[1]!.content;
  const m = /\[1\] \(source: [^)]*\)\n([^\n]*)/.exec(user)!;
  const firstSentence = m[1]!.split(/(?<=\.)\s/)[0]!;
  return Promise.resolve(JSON.stringify({ findings: [
    { claim: "Supported claim", quote: firstSentence, chunk: 1 },
    { claim: "Fabricated claim", quote: "LoRa reaches 500 km in every city.", chunk: 1 },
    { claim: "Bad index", quote: firstSentence, chunk: 99 }
  ] }));
}

const deps = (extra: Partial<ResearchDeps> = {}): ResearchDeps =>
  ({ search: fakeSearch, fetch: fakeFetch, embed: fakeEmbed, llm: fakeLlm, ...extra });

// ---------- test data ----------
const ideaId = `research-pipeline-test-${randomUUID()}`;
const idea = { id: ideaId, title: "[TEST] LoRa battery sensor", content: "A LoRa sensor node that runs on battery with deep sleep." };
const store = createResearchJobStore(db);
const findingCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM research_findings WHERE idea_id = ?`).get(ideaId) as { n: number }).n;
const jobRow = (id: string) => db.prepare(`SELECT status, result, error, lease_owner FROM jobs WHERE id = ?`).get(id) as any;
const claimFor = (jobId: string): ResearchJob => {
  const j = store.claim();
  if (!j || j.id !== jobId) throw new Error(`expected to claim ${jobId}, got ${j?.id}`);
  return j;
};

try {
  db.prepare(`INSERT INTO ideas (id, title, content, origin, depth) VALUES (?, ?, ?, 'user', 0)`).run(ideaId, idea.title, idea.content);
  // Make sure no other research jobs on the copy interfere.
  check("no pre-existing research jobs on copy", (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type='research_idea' AND status IN ('pending','running')`).get() as { n: number }).n === 0);

  // pickCandidates unit
  const picked = pickCandidates([[{ url: "https://x/1#a", title: "" }, { url: "mailto:a@b", title: "" }], [{ url: "https://x/1", title: "" }, { url: "https://y/2", title: "" }]], 5);
  check("candidates: dedupe (fragment stripped), non-http skipped, round-robin", JSON.stringify(picked.map(p => p.url)) === JSON.stringify(["https://x/1", "https://y/2"]), picked.map(p => p.url));

  // Per-source cap unit
  const mk = (src: string, score: number) => ({ id: `${src}-${score}`, source_id: src, text: "", url: "", score });
  const sel = selectTopChunks([mk("s1", 0.99), mk("s1", 0.98), mk("s1", 0.97), mk("s1", 0.96), mk("s2", 0.5), mk("s2", 0.4), mk("s2", 0.3), mk("s3", 0.1), mk("s4", 0.05)], 6, 2);
  const per = sel.reduce<Record<string, number>>((m, c) => (m[c.source_id] = (m[c.source_id] ?? 0) + 1, m), {});
  check("per-source cap: max 2 per source, filled by rank to 6", sel.length === 6 && Object.values(per).every(n => n <= 2) &&
    JSON.stringify(sel.map(c => c.id)) === JSON.stringify(["s1-0.99", "s1-0.98", "s2-0.5", "s2-0.4", "s3-0.1", "s4-0.05"]), sel.map(c => c.id));
  check("per-source cap configurable (3)", selectTopChunks([mk("s1", 0.9), mk("s1", 0.8), mk("s1", 0.7), mk("s1", 0.6)], 6, 3).length === 3);

  // Enqueue guards
  const job1 = store.enqueue(ideaId);
  let dupErr: unknown; try { store.enqueue(ideaId); } catch (e) { dupErr = e; }
  check("enqueue refused while active job exists", dupErr instanceof ActiveResearchJobError);
  let missErr: unknown; try { store.enqueue("no-such-idea"); } catch (e) { missErr = e; }
  check("enqueue refused for missing idea", /Idea not found/.test(String(missErr)));

  // Run 1
  const j1 = claimFor(job1);
  const r1 = await runResearch(db, idea, deps({ stillOwned: () => store.owns(j1) }));
  check("queries from LLM used", r1.result.queries.length === 3 && !r1.result.queryFallback, r1.result.queries);
  check("fetched sources (dedupe, ftp skipped, 404 recorded)", r1.result.fetched === 3 && r1.result.fetchFailed === 1 && !fetchCalls.some(u => u.startsWith("ftp")), { fetched: r1.result.fetched, fetchFailed: r1.result.fetchFailed, calls: fetchCalls });
  check("404 source stored with error", (db.prepare(`SELECT error FROM research_sources WHERE idea_id = ? AND url = 'https://missing.example/404'`).get(ideaId) as any)?.error === "HTTP 404");
  check("chunks embedded", r1.result.chunksEmbedded === r1.result.chunksTotal && r1.result.chunksTotal > 0, { embedded: r1.result.chunksEmbedded, total: r1.result.chunksTotal });
  check("top-ranked chunk is relevant (not the tomato page)", !/tomato/i.test(db.prepare(`SELECT text FROM research_chunks WHERE id = ?`).pluck().get(r1.findings[0]?.chunk_id ?? "") as string ?? "tomato"));
  check("verified quote kept (support=yes)", r1.findings.length === 1 && r1.result.droppedUnsupported === 0 && r1.result.droppedUnchecked === 0, r1.findings);
  check("pipeline reports distinct ranked sources", r1.result.rankedSources === 3, r1.result.rankedSources);
  check("fabricated quote dropped", r1.dropped.some(d => d.reason === "quote not found verbatim"), r1.dropped.map(d => d.reason));
  check("bad chunk number dropped", r1.dropped.some(d => d.reason === "bad chunk number"));
  const done1 = store.complete(j1, ideaId, r1.findings, r1.result);
  check("job completed with result JSON", jobRow(job1).status === "completed" && JSON.parse(jobRow(job1).result).findingsKept === 1, done1);
  const stored = db.prepare(`SELECT f.quote, f.verified, c.text FROM research_findings f JOIN research_chunks c ON c.id = f.chunk_id WHERE f.idea_id = ?`).all(ideaId) as any[];
  check("stored findings verified=1 and quote re-verifies against stored chunk", stored.length === 1 && stored.every(s => s.verified === 1 && verifyQuote(s.text, s.quote)));

  // Run 2: rerun, no duplicates, embeddings reused
  const job2 = store.enqueue(ideaId);
  const j2 = claimFor(job2);
  const r2 = await runResearch(db, idea, deps());
  check("rerun skips already-embedded chunks", r2.result.chunksEmbedded === 0, r2.result.chunksEmbedded);
  const done2 = store.complete(j2, ideaId, r2.findings, r2.result);
  check("rerun inserts no duplicate findings", findingCount() === 1 && done2.findingsInserted === 0 && done2.findingsDuplicate === 1, done2);

  // Bad LLM JSON -> fallback to idea title
  llmMode = "garbage";
  const r3 = await runResearch(db, idea, deps());
  check("bad query JSON falls back to idea title", r3.result.queryFallback && JSON.stringify(r3.result.queries) === JSON.stringify([idea.title]), r3.result.queries);
  llmMode = "good";

  // Claim-support check cases (no DB writes: runResearch only stores sources/chunks)
  supportMode = "no";
  const rNo = await runResearch(db, idea, deps());
  check("unsupported claim dropped", rNo.findings.length === 0 && rNo.result.droppedUnsupported === 1 && rNo.result.findingsKept === 0, rNo.result);
  supportMode = "partial";
  const rPart = await runResearch(db, idea, deps());
  check("partial claim dropped", rPart.findings.length === 0 && rPart.result.droppedPartial === 1);
  supportMode = "bad"; supportCalls = 0;
  const rBad = await runResearch(db, idea, deps());
  check("bad support JSON: retried once, then dropped as unchecked", rBad.findings.length === 0 && rBad.result.droppedUnchecked === 1 && rBad.result.supportAttempts === 2 && supportCalls === 2 && !!rBad.result.supportError, { attempts: rBad.result.supportAttempts, calls: supportCalls });
  supportMode = "bad-once"; supportCalls = 0;
  const rRetry = await runResearch(db, idea, deps());
  check("bad support JSON once: retry succeeds and keeps 'yes'", rRetry.findings.length === 1 && rRetry.result.supportAttempts === 2 && rRetry.result.droppedUnchecked === 0);
  supportMode = "yes";

  // SourceInUse: content changed but findings reference chunks -> keep existing
  const chunkIdsBefore = db.prepare(`SELECT c.id FROM research_chunks c JOIN research_sources s ON s.id = c.source_id WHERE s.idea_id = ? ORDER BY c.id`).pluck().all(ideaId);
  const usedUrl = db.prepare(`SELECT s.url FROM research_findings f JOIN research_chunks c ON c.id = f.chunk_id JOIN research_sources s ON s.id = c.source_id WHERE f.idea_id = ?`).pluck().get(ideaId) as string;
  const original = PAGES[usedUrl]!;
  PAGES[usedUrl] = original + " This sentence was added later.";
  let threw: unknown;
  let r4: Awaited<ReturnType<typeof runResearch>> | undefined;
  try { r4 = await runResearch(db, idea, deps()); } catch (e) { threw = e; }
  PAGES[usedUrl] = original;
  const chunkIdsAfter = db.prepare(`SELECT c.id FROM research_chunks c JOIN research_sources s ON s.id = c.source_id WHERE s.idea_id = ? ORDER BY c.id`).pluck().all(ideaId);
  check("SourceInUseError handled, existing chunks kept, source still used", !threw && r4!.result.sourcesInUse === 1 && r4!.result.fetched === 3 && JSON.stringify(chunkIdsBefore) === JSON.stringify(chunkIdsAfter), { threw: String(threw ?? ""), inUse: r4?.result.sourcesInUse });

  // Stale worker cannot complete
  const job3 = store.enqueue(ideaId);
  const a = claimFor(job3);
  db.prepare(`UPDATE jobs SET lease_until = ? WHERE id = ?`).run(Date.now() - 1000, job3);
  const b = claimFor(job3);
  check("expired lease taken over by B", b.lease_owner !== a.lease_owner && jobRow(job3).lease_owner === b.lease_owner);
  const fakeNew = [{ claim: "stale", quote: "stale quote", chunk_id: chunkIdsAfter[0] as string }];
  let staleErr: unknown; try { store.complete(a, ideaId, fakeNew, { stale: true }); } catch (e) { staleErr = e; }
  check("stale worker A complete() refused with LeaseLostError", staleErr instanceof LeaseLostError);
  check("stale worker A wrote no findings", findingCount() === 1);
  check("stale worker A fail() not owned", store.fail(a, "x").owned === false && jobRow(job3).status === "running");
  check("stillOwned=false aborts pipeline", await runResearch(db, idea, deps({ stillOwned: () => store.owns(a) })).then(() => false, e => /Lease lost/.test(String(e))));
  const r5 = await runResearch(db, idea, deps({ stillOwned: () => store.owns(b) }));
  const done5 = store.complete(b, ideaId, r5.findings, r5.result);
  check("owner B completes", jobRow(job3).status === "completed" && done5.findingsDuplicate === 1 && findingCount() === 1);
} finally {
  db.prepare(`DELETE FROM research_findings WHERE idea_id = ?`).run(ideaId);
  db.prepare(`DELETE FROM research_chunks WHERE source_id IN (SELECT id FROM research_sources WHERE idea_id = ?)`).run(ideaId);
  db.prepare(`DELETE FROM research_sources WHERE idea_id = ?`).run(ideaId);
  db.prepare(`DELETE FROM jobs WHERE type = 'research_idea' AND json_extract(payload, '$.ideaId') = ?`).run(ideaId);
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(ideaId);
  db.close();
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
