import { readFileSync } from "node:fs";
// Research pipeline test with deterministic fake search/fetch/embed/llm. No network, no model.
// Runs ONLY against a copy of the database given by BRAIN_DB.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-research-pipeline.ts

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureResearchTables } from "./research-schema.js";
import { sha256, verifyQuote, type FetchResult } from "./research-sources.js";
import { runResearch, pickCandidates, selectTopChunks, selectPerQuestion, boostFor, siteKey, sourceType, parseQuestions, SYNTH_MODEL, type ResearchDeps, type ChatMessage } from "./research.js";
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
  "https://lora.example/lora": "LoRa radios use chirp spread spectrum modulation. A LoRa sensor node can run for years on a battery when it transmits rarely. Range depends on spreading factor and terrain.",
  "https://battery.example/battery": "Battery life of a sensor depends mostly on sleep current. Deep sleep on the ESP32-S3 draws microamps. Transmitting dominates the energy budget.",
  "https://garden.example/other": "Gardening tips for tomatoes. Water in the morning. Use mulch."
};
let llmMode: "good" | "garbage" | "badQueries" = "good";
let supportMode: "yes" | "partial" | "no" | "bad" | "bad-once" = "yes";
let supportCalls = 0;
let synthMode: "default" | "multi" | "claimVariant" | "assign" = "default";
let lastSynthSystem = "";
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
  { url: "https://lora.example/lora#section", title: "A" },
  { url: "ftp://files.example/x", title: "ftp" },
  { url: "https://missing.example/404", title: "404" },
  { url: q.length % 2 ? "https://battery.example/battery" : "https://garden.example/other", title: "B/C" },
  { url: "https://lora.example/lora", title: "A dup" }
]);

const KEYS = ["lora", "battery", "sensor", "sleep", "tomato"];
// "[offtopic]" texts point away from every question (negative cosine) -> below any threshold.
const fakeEmbed = (texts: string[]) => Promise.resolve(texts.map(t => t.includes("[offtopic]") ? KEYS.map(() => -1)
  : KEYS.map(k => (t.toLowerCase().split(k).length - 1) + 0.01)));
const systemPrompts: string[] = [];

const modelCalls: Array<{ kind: string; model: string | undefined }> = [];
function fakeLlm(messages: ChatMessage[], opts: { model?: string } = {}): Promise<string> {
  const sys = messages[0]!.content;
  systemPrompts.push(sys);
  modelCalls.push({ kind: sys.includes("open questions") ? "questions" : sys.includes("write web search queries") ? "queries"
    : sys.includes("judge only whether the QUOTE supports") ? "judge" : "synthesis", model: opts.model });
  if (sys.includes("open questions")) {
    return Promise.resolve(llmMode === "garbage" ? "I cannot help with that."
      : JSON.stringify({ questions: ["How long can a LoRa sensor run on battery?", "What deep sleep current does the ESP32-S3 draw?", "What range does LoRa reach?"] }));
  }
  if (sys.includes("write web search queries")) {
    return Promise.resolve(llmMode === "badQueries" ? "not json"
      : JSON.stringify({ queries: ["LoRa sensor battery life", "ESP32-S3 deep sleep current", "LoRa range"] }));
  }
  if (sys.includes("judge only whether the QUOTE supports")) {
    supportCalls++;
    const claimsIn = [...messages[1]!.content.matchAll(/^CLAIM: (.*)$/gm)].map(m => m[1]!);
    const n = claimsIn.length;
    if (supportMode === "bad" || (supportMode === "bad-once" && supportCalls === 1)) return Promise.resolve("I think they are fine");
    const level = supportMode === "bad-once" ? "yes" : supportMode;
    const sup = (c: string) => c.includes("[nosupport]") ? "no" : level;
    return Promise.resolve(JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ index: i + 1, supported: sup(claimsIn[i]!), subject: `subject of ${i + 1}` })) }));
  }
  lastSynthSystem = sys;
  // Synthesis: quote the first sentence of excerpt 1 verbatim, plus a fabricated quote and a bad chunk number.
  const user = messages[1]!.content;
  const m = /\[1\] \([^)]*\)\n([^\n]*)/.exec(user)!;
  const firstSentence = m[1]!.split(/(?<=\.)\s/)[0]!;
  const excerpts = [...user.matchAll(/\[(\d+)\] \([^)]*\)\n([^\n]*)/g)].map(x => ({ n: Number(x[1]), sentences: x[2]!.split(/(?<=\.)\s/) }));
  if (synthMode === "claimVariant") {
    return Promise.resolve(JSON.stringify({ findings: [
      { claim: "  SUPPORTED   claim!! ", quote: excerpts[0]!.sentences[1]!, chunk: 1 }
    ] }));
  }
  if (synthMode === "assign") {
    const [e1, e2, e3] = excerpts;
    return Promise.resolve(JSON.stringify({ findings: [
      { claim: "assign deep sleep", quote: e1!.sentences[0], chunk: e1!.n },
      { claim: "assign [offtopic]", quote: e2!.sentences[0], chunk: e2!.n },
      { claim: "assign battery sleep [nosupport]", quote: e3!.sentences[0], chunk: e3!.n }
    ] }));
  }
  if (synthMode === "multi") {
    const [e1, e2, e3] = excerpts;
    return Promise.resolve(JSON.stringify({ findings: [
      { claim: "multi A1", quote: e1!.sentences[0], chunk: e1!.n, question: 1 },
      { claim: "multi A2", quote: e1!.sentences[1], chunk: e1!.n, question: 1 },
      { claim: "multi A3", quote: e1!.sentences[2], chunk: e1!.n, question: 1 },
      { claim: "multi reused", quote: e1!.sentences[0], chunk: e1!.n, question: 1 },
      { claim: "multi B [offtopic]", quote: e2!.sentences[0], chunk: e2!.n, question: 2 },
      { claim: "multi C [medium]", quote: e3!.sentences[0], chunk: e3!.n, question: "Q3" }
    ] }));
  }
  return Promise.resolve(JSON.stringify({ findings: [
    { claim: "Supported claim", quote: firstSentence, chunk: 1, question: 99 },
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

  // Site keys
  const keys = ["https://openelab.com/a", "https://openelab.io/b", "https://news.bbc.co.uk/x", "https://www.example.com.au/y",
    "https://pmc.ncbi.nlm.nih.gov/articles/1", "https://wiki.heltec.org/docs", "https://heltec.org/p"].map(siteKey);
  check("site key: openelab.com/.io grouped, multi-part TLDs, subdomains", JSON.stringify(keys) ===
    JSON.stringify(["openelab", "openelab", "bbc", "example", "nih", "heltec", "heltec"]), keys);
  const types = ["https://pmc.ncbi.nlm.nih.gov/articles/1", "https://arxiv.org/abs/1", "https://cs.mit.edu/p", "https://docs.espressif.com/x",
    "https://lib.readthedocs.io/en", "https://github.com/meshtastic/firmware", "https://en.wikipedia.org/wiki/LoRa",
    "https://www.reddit.com/r/x", "https://electronics.stackexchange.com/q/1", "https://openelab.com/blogs/learn/x", "https://vendor.com/files/ds.pdf"].map(sourceType);
  check("source types by domain/path", JSON.stringify(types) === JSON.stringify(["paper", "paper", "paper", "docs", "docs", "docs", "reference", "forum", "forum", "blog", "docs"]), types);
  const cands = pickCandidates([
    [{ url: "https://openelab.com/1", title: "" }, { url: "https://openelab.io/2", title: "" }, { url: "https://openelab.net/3", title: "" }, { url: "https://arxiv.org/abs/9", title: "" }],
    [{ url: "https://www.reddit.com/r/x", title: "" }, { url: "https://en.wikipedia.org/wiki/LoRa", title: "" }],
    [{ url: "https://openelab.com/4", title: "" }]
  ], 10, 2);
  check("candidates: site cap (max 2 openelab)", cands.filter(c => c.site === "openelab").length === 2, cands.map(c => c.url));
  check("candidates: type order paper > reference > forum > blog", JSON.stringify(cands.map(c => c.type)) === JSON.stringify(["paper", "reference", "forum", "blog", "blog"]), cands.map(c => c.type));
  check("candidates: every query contributes", new Set(cands.map(c => c.query)).size === 3, cands.map(c => c.query));
  check("pdf URLs skipped as candidates", pickCandidates([[{ url: "https://arxiv.org/pdf/2512.07408", title: "" }, { url: "https://x.org/a.pdf", title: "" }, { url: "https://arxiv.org/abs/1", title: "" }]], 10).map(c => c.url).join() === "https://arxiv.org/abs/1");
  check("parseQuestions: numbered/bulleted lines, dedupe", JSON.stringify(parseQuestions("Here:\n1. What range is achievable?\n2) **How much power is used?**\n- What range is achievable?\nnoise")) ===
    JSON.stringify(["What range is achievable?", "How much power is used?"]));

  // Per-question selection
  const v = (...x: number[]) => x;
  const pc = [
    { id: "c1", source_id: "s1", site: "s1", type: "blog" as const, text: "", url: "", vec: v(1, 0, 0) },
    { id: "c2", source_id: "s1", site: "s1", type: "blog" as const, text: "", url: "", vec: v(0.9, 0.1, 0) },
    { id: "c3", source_id: "s2", site: "s2", type: "blog" as const, text: "", url: "", vec: v(0.8, 0.2, 0) },
    { id: "c4", source_id: "s3", site: "s3", type: "blog" as const, text: "", url: "", vec: v(0, 1, 0) },
    { id: "c5", source_id: "s4", site: "s4", type: "blog" as const, text: "", url: "", vec: v(0, 0.9, 0.1) },
    { id: "c6", source_id: "s5", site: "s5", type: "blog" as const, text: "", url: "", vec: v(0, 0, 1) }
  ];
  const pq = selectPerQuestion(pc, [v(1, 0, 0), v(1, 0, 0), v(0, 1, 0)], { perQuestion: 2, total: 5, perSite: 2 });
  check("per-question: round-robin, labeled by question, no duplicate chunks", JSON.stringify(pq.map(c => `${c.question}:${c.id}`)) ===
    JSON.stringify(["1:c1", "2:c2", "3:c4", "1:c3", "2:c5"]) && new Set(pq.map(c => c.id)).size === pq.length, pq.map(c => `${c.question}:${c.id}`));
  const pqSite = selectPerQuestion(pc, [v(1, 0, 0)], { perQuestion: 3, total: 8, perSite: 1 });
  check("per-question: per-site cap respected", JSON.stringify(pqSite.map(c => c.id)) === JSON.stringify(["c1", "c3", "c4"]), pqSite.map(c => c.id));
  const blocked = pickCandidates([[{ url: "https://www.researchgate.net/publication/1", title: "" }, { url: "https://dl.acm.org/doi/1", title: "" }, { url: "https://someblog.com/a", title: "" }]], 10);
  check("blocked sites deprioritized after blogs", JSON.stringify(blocked.map(c => c.site)) === JSON.stringify(["someblog", "researchgate", "acm"]), blocked.map(c => c.site));
  check("blocked sites get no type boost", boostFor({ type: "paper", site: "researchgate" }) === 0 && boostFor({ type: "paper", site: "nih" }) > 0);

  // generateResponse default model unchanged, override passed through (fetch intercepted, no Ollama call)
  {
    const realFetch = globalThis.fetch;
    const bodies: any[] = [];
    globalThis.fetch = (async (_u: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ message: { content: "ok" }, done_reason: "stop" }), { status: 200 });
    }) as typeof fetch;
    try {
      const { generateResponse } = await import("./ai.js");
      await generateResponse([{ role: "user", content: "x" }]);
      await generateResponse([{ role: "user", content: "x" }], { model: "gemma4:e4b-it-qat", numCtx: 8192 });
    } finally { globalThis.fetch = realFetch; }
    check("generateResponse default model is qwen3:4b, num_ctx 2048", bodies[0]?.model === "qwen3:4b" && bodies[0]?.options.num_ctx === 2048, bodies[0]?.model);
    check("generateResponse model override passed through", bodies[1]?.model === "gemma4:e4b-it-qat" && bodies[1]?.options.num_ctx === 8192, bodies[1]?.model);
  }

  // Per-source cap unit
  const mk = (src: string, score: number) => ({ id: `${src}-${score}`, source_id: `${src}-id`, site: src, type: "blog" as const, text: "", url: "", score });
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
  check("questions generated then one query per question", r1.result.questions.length === 3 && r1.result.queries.length === 3 && !r1.result.queryFallback && r1.result.queryFallbackKind === "none", r1.result.questions);
  const fd0 = r1.result.findingsDetail[0];
  check("finding has similarity, question text, subject, excerpt question", fd0?.outcome === "kept" && typeof fd0?.similarity === "number" &&
    fd0!.similarity! >= r1.result.minQuestionSim && fd0?.questionText === r1.result.questions[fd0!.question! - 1] && fd0?.subject === "subject of 1" && "excerptQuestion" in fd0!, fd0);
  check("synthesis prompt asks claims to name the specific subject", lastSynthSystem.includes("must name the specific subject"));
  check("no hardware fields remain in result/findingsDetail", !JSON.stringify(r1.result).includes("hardware") && !("hardware" in fd0!));
  check("per-question ranking used; excerpts labeled by question", r1.result.rankingMode === "per_question" && r1.result.excerpts.every(e => e.question !== null), r1.result.excerpts.map(e => e.question));
  const kinds = (k: string) => modelCalls.filter(c => c.kind === k).map(c => c.model);
  check("synth + judge use SYNTH_MODEL; questions + queries use default", kinds("synthesis").length > 0 && kinds("synthesis").every(m => m === SYNTH_MODEL) &&
    kinds("judge").every(m => m === SYNTH_MODEL) && kinds("questions").every(m => m === undefined) && kinds("queries").every(m => m === undefined), { synth: kinds("synthesis")[0], judge: kinds("judge")[0], q: kinds("questions")[0] });
  check("result JSON has source type/site and distinct sites", r1.result.distinctSites === 3 && r1.result.sourcesDetail.every(d => d.type === "blog" && d.site.length > 0), r1.result.sourcesDetail.map(d => d.site));
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
  check("no questions -> idea-text ranking fallback", r3.result.rankingMode === "idea" && r3.result.excerpts.every(e => e.question === null));
  check("bad query JSON falls back to idea title", r3.result.queryFallback && JSON.stringify(r3.result.queries) === JSON.stringify([idea.title]), r3.result.queries);
  llmMode = "badQueries";
  const r3b = await runResearch(db, idea, deps());
  check("bad query JSON with good questions: questions used as queries", r3b.result.queryFallbackKind === "questions_as_queries" && JSON.stringify(r3b.result.queries) === JSON.stringify(r3b.result.questions), r3b.result.queries);
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

  // Quote reuse, per-source kept cap, relevance
  synthMode = "multi";
  const rm = await runResearch(db, idea, deps());
  synthMode = "default";
  const outcome = (c: string) => rm.checked.find(f => f.claim === c)?.outcome;
  check("reused quote dropped (first use kept)", rm.result.droppedReusedQuote === 1 && outcome("multi A1") === "kept" && !rm.checked.some(f => f.claim === "multi reused"), rm.result.droppedReusedQuote);
  check("per-source kept cap (max 2 per source)", rm.result.droppedSourceCap === 1 && outcome("multi A3") === "source_cap" && outcome("multi A2") === "kept");
  check("off-topic claim (below similarity threshold) dropped", rm.result.droppedNoQuestion === 1 && outcome("multi B [offtopic]") === "no_question");
  check("claim answering its question kept", outcome("multi C [medium]") === "kept");
  check("multi run keeps exactly A1, A2, C", JSON.stringify(rm.findings.map(f => f.claim)) === JSON.stringify(["multi A1", "multi A2", "multi C [medium]"]), rm.findings.map(f => f.claim));

  // Question assignment by embedding similarity; judge filters only on support
  synthMode = "assign";
  const ra = await runResearch(db, idea, deps());
  synthMode = "default";
  const ad = (c: string) => ra.result.findingsDetail.find(f => f.claim === c);
  check("minQuestionSim default is 0.6 (unless env override)", process.env.RESEARCH_MIN_QUESTION_SIM !== undefined || ra.result.minQuestionSim === 0.6, ra.result.minQuestionSim);
  check("claim assigned to most similar question (deep sleep -> Q2)", ad("assign deep sleep")?.question === 2 && ad("assign deep sleep")?.outcome === "kept" && (ad("assign deep sleep")?.similarity ?? 0) > 0.9, ad("assign deep sleep"));
  check("below-threshold claim dropped as no_question, similarity recorded", ad("assign [offtopic]")?.outcome === "no_question" && ad("assign [offtopic]")?.question === null && (ad("assign [offtopic]")?.similarity ?? 1) < ra.result.minQuestionSim && ra.result.droppedNoQuestion === 1);
  check("judge filters only on support (on-topic but unsupported dropped)", ad("assign battery sleep [nosupport]")?.outcome === "unsupported" && ra.result.similarityDistribution.length === 3);
  const banned = /lora|heltec|\bboard\b|hardware|esp32|sx126/i;
  check("no domain words in any system prompt sent", systemPrompts.length > 0 && systemPrompts.every(p => !banned.test(p)), systemPrompts.find(p => banned.test(p))?.slice(0, 200));
  const src = readFileSync(new URL("./research.ts", import.meta.url), "utf8");
  check("research.ts source has no LoRa/Heltec/board/hardware strings", !banned.test(src), src.match(banned)?.[0]);

  // Claim dedupe across runs: different quote, same normalized claim
  synthMode = "claimVariant";
  const jobCv = store.enqueue(ideaId);
  const jcv = claimFor(jobCv);
  const rcv = await runResearch(db, idea, deps());
  synthMode = "default";
  const before = findingCount();
  const dcv = store.complete(jcv, ideaId, rcv.findings, rcv.result);
  check("claim dedupe across runs (case/space/punctuation-insensitive)", rcv.findings.length === 1 && dcv.findingsDuplicateClaim === 1 && dcv.findingsInserted === 0 && findingCount() === before, dcv);

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
