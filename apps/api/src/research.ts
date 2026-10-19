// Evidence-backed research pipeline for one idea.
// Pure orchestration with injectable deps (search, fetch, embed, llm) for testing.
// No model call or network request ever runs inside a DB transaction:
// every DB write here is a short statement or a short immediate transaction.

import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createResearchSourceStore, fetchSource, SourceInUseError, verifyQuote, type FetchResult
} from "./research-sources.js";
import type { NewFinding } from "./research-jobs.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type SearchHit = { url: string; title: string };
export type Candidate = SearchHit & { site: string; type: SourceType; query: number };

export type ResearchDeps = {
  search: (query: string) => Promise<SearchHit[]>;
  fetch: (url: string) => Promise<FetchResult>;
  embed: (texts: string[]) => Promise<number[][]>;
  llm: (messages: ChatMessage[], opts: { format?: "json"; temperature: number; numPredict: number; numCtx?: number }) => Promise<string>;
  log?: (msg: string) => void;
  /** Return false to abort early (lease lost). */
  stillOwned?: () => boolean;
};

export const LIMITS = {
  maxQueries: 5, maxSources: 5, maxCandidates: 15, maxCandidatesPerSite: 2,
  topChunks: 6, maxChunksPerSite: 2, maxFindingsPerSite: 2, embedBatch: 16
};

// ---------- source grouping and typing ----------

export type SourceType = "paper" | "docs" | "reference" | "forum" | "blog";
export const TYPE_ORDER: SourceType[] = ["paper", "docs", "reference", "forum", "blog"];
/** Small additive boost to cosine similarity when ranking chunks (configurable). */
export const TYPE_BOOST: Record<SourceType, number> = { paper: 0.03, docs: 0.02, reference: 0.01, forum: 0, blog: 0 };

const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "ac.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr", "co.in", "org.in", "ac.in",
  "com.br", "com.cn", "com.tw", "com.hk", "com.sg", "com.mx", "com.ar", "co.za", "com.tr"
]);

/** Registrable name without TLD: openelab.com and openelab.io -> "openelab"; bbc.co.uk -> "bbc". */
export function siteKey(u: string): string {
  let host: string;
  try { host = new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return u; }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_TLDS.has(lastTwo) && labels.length >= 3) return labels[labels.length - 3]!;
  return labels[labels.length - 2]!;
}

const PAPER_HOSTS = ["pmc.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "arxiv.org", "doi.org", "ieeexplore.ieee.org", "ieee.org",
  "mdpi.com", "sciencedirect.com", "springer.com", "link.springer.com", "dl.acm.org", "acm.org", "researchgate.net",
  "semanticscholar.org", "nature.com", "frontiersin.org", "hindawi.com", "wiley.com", "tandfonline.com", "iopscience.iop.org"];
const FORUM_HOSTS = ["reddit.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com", "quora.com"];

const hostMatches = (host: string, list: string[]) => list.some(h => host === h || host.endsWith("." + h));

export function sourceType(u: string): SourceType {
  let url: URL;
  try { url = new URL(u); } catch { return "blog"; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, PAPER_HOSTS) || host.endsWith(".edu") || /\.(ac|edu)\.[a-z]{2}$/.test(host)) return "paper";
  if (hostMatches(host, ["wikipedia.org"])) return "reference";
  if (hostMatches(host, FORUM_HOSTS) || /^forums?\./.test(host) || /^community\./.test(host) ||
      /\/(forum|forums|community|discussions?)\//.test(path)) return "forum";
  if (/^(docs|wiki|developer|developers)\./.test(host) || host.endsWith(".readthedocs.io") ||
      (host === "github.com") || /\/(docs|documentation|datasheet|datasheets)(\/|$)/.test(path) || path.endsWith(".pdf")) return "docs";
  return "blog";
}

export type Idea = { id: string; title: string; content: string };

// ---------- helpers ----------

export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in model output");
  return JSON.parse(raw.slice(start, end + 1));
}

export function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

export function fromBlob(b: Buffer): Float32Array {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na && nb ? dot / Math.sqrt(na * nb) : -1;
}

function normalizeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export function isPdfUrl(u: string): boolean {
  try { const p = new URL(u).pathname.toLowerCase(); return p.endsWith(".pdf") || /\/pdf(\/|$)/.test(p); } catch { return false; }
}

/**
 * Select fetch candidates: dedupe URLs, http(s) only, at most `perSite` per site key.
 * Pass 1 takes the best-typed hit from each query (query diversity);
 * pass 2 fills the rest by source type (paper > docs > reference > forum > blog), then round-robin position.
 */
export function pickCandidates(lists: SearchHit[][], max: number, perSite = LIMITS.maxCandidatesPerSite): Candidate[] {
  const seen = new Set<string>();
  const pool: Array<Candidate & { pos: number }> = [];
  for (let i = 0, pos = 0; lists.some(l => i < l.length); i++) {
    lists.forEach((list, q) => {
      const hit = list[i];
      if (!hit) return;
      const url = normalizeUrl(hit.url);
      if (!url || seen.has(url)) return;
      seen.add(url);
      if (isPdfUrl(url)) return;   // the fetcher accepts only text/html and text/plain
      pool.push({ url, title: hit.title, site: siteKey(url), type: sourceType(url), query: q, pos: pos++ });
    });
  }
  const rank = (c: { type: SourceType; pos: number }) => TYPE_ORDER.indexOf(c.type) * 1e6 + c.pos;
  const out: Array<Candidate & { pos: number }> = [];
  const perSiteCount = new Map<string, number>();
  const take = (c: Candidate & { pos: number }) => {
    if (out.length >= max || out.includes(c)) return false;
    const n = perSiteCount.get(c.site) ?? 0;
    if (n >= perSite) return false;
    perSiteCount.set(c.site, n + 1);
    out.push(c);
    return true;
  };
  for (let q = 0; q < lists.length; q++) {
    for (const c of pool.filter(p => p.query === q).sort((x, y) => rank(x) - rank(y))) if (take(c)) break;
  }
  for (const c of [...pool].sort((x, y) => rank(x) - rank(y))) take(c);
  return out.sort((x, y) => rank(x) - rank(y)).map(({ pos: _p, ...c }) => c);
}

// ---------- step 1: open questions, then one query per question ----------

const QueriesSchema = z.object({ queries: z.array(z.string().trim().min(3).max(200)).min(1) });
const QuestionsSchema = z.object({ questions: z.array(z.string().trim().min(8).max(300)).min(1) });

export function parseQuestions(raw: string): string[] {
  const qs = raw.split("\n")
    .map(l => /^\s*(?:\d+[.):]|[-*•])\s*(.+?)\s*$/.exec(l)?.[1] ?? "")
    .map(q => q.replace(/^\*\*|\*\*$/g, "").trim())
    .filter(q => q.length >= 8 && q.length <= 300);
  return [...new Set(qs)].slice(0, LIMITS.maxQueries);
}

export async function generateQueries(idea: Idea, deps: ResearchDeps): Promise<{
  questions: string[]; queries: string[]; fallback: boolean; queryFallback: "none" | "questions_as_queries" | "title";
}> {
  const title = { questions: [], queries: [idea.title], fallback: true, queryFallback: "title" as const };
  let questions: string[] = [];
  try {
    const raw = await deps.llm([
      { role: "system", content: `You help evaluate an engineering idea. List the 3 to 5 most important open questions the idea depends on
(for example: achievable range, power budget and battery life, gateway or integration options, real-world deployments, hardware limits).
Each question must be specific and answerable with evidence from the web.
Return ONLY JSON: {"questions": ["...", "..."]}. No markdown, no commentary.` },
      { role: "user", content: `Idea title: ${idea.title}\nDescription: ${idea.content}` }
    // JSON mode: in plain-text mode qwen3:4b leaks its reasoning instead of a list.
    ], { format: "json", temperature: 0, numPredict: 400 });
    const parsed = QuestionsSchema.safeParse((() => { try { return extractJsonObject(raw); } catch { return null; } })());
    questions = parsed.success
      ? [...new Set(parsed.data.questions.map(q => q.trim()))].slice(0, LIMITS.maxQueries)
      : parseQuestions(raw);   // fallback: numbered/bulleted lines
  } catch (e) {
    deps.log?.(`question generation failed: ${String(e).slice(0, 200)}`);
  }
  if (questions.length === 0) {
    deps.log?.("no questions parsed, falling back to idea title");
    return title;
  }
  for (let attempt = 1; attempt <= 2; attempt++) try {
    const raw = await deps.llm([
      { role: "system", content: `You write web search queries. For each numbered question write exactly one short, specific search query.
Each query: 3 to 8 keywords, no question words, no repetition.
Return ONLY JSON: {"queries": ["query for question 1", "query for question 2", ...]} in the same order. No markdown, no commentary.` },
      { role: "user", content: `Idea title: ${idea.title}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nWrite one search query per question as {"queries": [...]}.` }
    ], { format: "json", temperature: 0, numPredict: 300 });
    const parsed = QueriesSchema.parse(extractJsonObject(raw));
    const queries = [...new Set(parsed.queries.map(q => q.trim()))].slice(0, LIMITS.maxQueries);
    return { questions, queries, fallback: false, queryFallback: "none" };
  } catch (e) {
    deps.log?.(`query generation attempt ${attempt} failed: ${String(e).slice(0, 200)}`);
  }
  deps.log?.("using questions as queries");
  return { questions, queries: questions, fallback: false, queryFallback: "questions_as_queries" };
}

// ---------- step 5: synthesis ----------

const FindingsSchema = z.object({
  findings: z.array(z.object({
    claim: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    chunk: z.number().int(),
    // Models sometimes return "2" or "Q2"; anything unparseable becomes "no question".
    question: z.preprocess(v => {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(/\d+/.exec(v)?.[0]) : NaN;
      return Number.isInteger(n) ? n : undefined;
    }, z.number().int().optional())
  }))
});

export type RankedChunk = { id: string; source_id: string; site: string; type: SourceType; text: string; url: string; score: number };

/** Highest-scoring chunks, at most `perSite` from any one site key, `total` overall. */
export function selectTopChunks(chunks: RankedChunk[], total: number, perSite: number): RankedChunk[] {
  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const perCount = new Map<string, number>();
  const out: RankedChunk[] = [];
  for (const c of sorted) {
    if (out.length >= total) break;
    const n = perCount.get(c.site) ?? 0;
    if (n >= perSite) continue;
    perCount.set(c.site, n + 1);
    out.push(c);
  }
  return out;
}

// ---------- claim support check ----------

const SupportSchema = z.object({
  results: z.array(z.object({
    index: z.number().int(),
    supported: z.enum(["yes", "partial", "no"]),
    answers: z.enum(["yes", "no"])
  }))
});

export type SupportLevel = "yes" | "partial" | "no";
export type Rating = { supported: SupportLevel; answers: "yes" | "no" } | "unchecked";

/** Case/whitespace/punctuation-insensitive form used for claim and quote dedupe. */
export function normalizeForDedupe(s: string): string {
  return s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * One batched LLM call rating each claim against its quote (support) and against its question
 * ("does this claim help answer question N?"). Without a question, the idea itself is the question.
 * Invalid output is retried once; if still invalid, every finding is "unchecked" (dropped by the caller).
 * A finding the model does not rate is also "unchecked".
 */
export async function checkSupport(
  idea: Idea, findings: Array<{ claim: string; quote: string; question?: string | null }>, deps: ResearchDeps
): Promise<{ ratings: Rating[]; attempts: number; error: string | null }> {
  if (findings.length === 0) return { ratings: [], attempts: 0, error: null };
  const items = findings.map((f, i) => ({ index: i + 1, ...f }));
  let error: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await deps.llm([
        { role: "system", content: `For each item, rate two things.
"supported":
- "yes": the quote alone fully states the claim; nothing in the claim goes beyond the quote.
- "partial": the quote supports only part of the claim, or the claim adds details, specifics or certainty not in the quote.
- "no": the quote does not support the claim.
"answers": does this claim help answer the item's QUESTION? "yes" only if the claim gives concrete evidence toward an answer.
Generic, promotional or off-topic claims are "no". A claim about different hardware than the question asks about is "no".
Be strict. Judge support only from the quote text.
Return ONLY JSON: {"results": [{"index": N, "supported": "yes"|"partial"|"no", "answers": "yes"|"no"}]} with one entry per item.` },
        { role: "user", content: `IDEA: ${idea.title}\n${idea.content}\n\n` + items.map(it =>
          `ITEM ${it.index}\nQUESTION: ${it.question ?? `Is ${idea.title} feasible as described?`}\nCLAIM: ${it.claim}\nQUOTE: ${it.quote}`).join("\n\n") }
      ], { format: "json", temperature: 0, numPredict: 600, numCtx: 4096 });
      const parsed = SupportSchema.parse(extractJsonObject(raw));
      const byIndex = new Map(parsed.results.map(r => [r.index, { supported: r.supported, answers: r.answers }]));
      return { ratings: items.map(it => byIndex.get(it.index) ?? "unchecked"), attempts: attempt, error: null };
    } catch (e) {
      error = String(e).slice(0, 300);
      deps.log?.(`support check attempt ${attempt} invalid: ${error.slice(0, 160)}`);
    }
  }
  return { ratings: items.map(() => "unchecked" as const), attempts: 2, error };
}

export type VerifiedFinding = NewFinding & { question: number | null };

export async function synthesize(idea: Idea, chunks: RankedChunk[], deps: ResearchDeps, questions: string[] = []) {
  const numbered = chunks.map((c, i) => `[${i + 1}] (source: ${c.url})\n${c.text}`).join("\n\n");
  const qBlock = questions.length ? `\n\nQUESTIONS:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "";
  const raw = await deps.llm([
    { role: "system", content: `You extract evidence about an engineering idea from numbered source excerpts.
Return ONLY JSON: {"findings": [{"claim": "...", "quote": "...", "chunk": N, "question": Q}]}
Rules:
- "quote" MUST be copied verbatim, character for character, from excerpt N. Do not paraphrase, shorten with ellipses, or fix typos.
- Each quote must be ONE contiguous sentence or fragment copied exactly as it appears in the excerpt.
- Never merge list items, bullet points or separate lines into one quote; never add or remove punctuation.
- Keep each quote to one or two sentences.
- Use each quote at most once. Never attach the same quote to two claims.
- Prefer findings from different excerpts and sources; at most 2 findings per source.
- Claims must be specific and directly about the idea (its hardware, approach and constraints), not generic marketing statements.
- "claim" is a short factual statement that the quote directly supports and that is relevant to the idea.
- "chunk" is the number of the excerpt containing the quote.
${questions.length ? `- "question" is the number (integer) of the QUESTION the finding helps answer. Only include findings that help answer a question.` : `- Omit "question".`}
- Use only the excerpts. If nothing is relevant, return {"findings": []}.
- At most 8 findings. No markdown, no commentary.` },
    { role: "user", content: `IDEA: ${idea.title}\n${idea.content}${qBlock}\n\nEXCERPTS:\n${numbered}` }
  ], { format: "json", temperature: 0, numPredict: 1200, numCtx: 8192 });

  const parsed = FindingsSchema.parse(extractJsonObject(raw));
  const kept: VerifiedFinding[] = [];
  const dropped: Array<{ claim: string; quote: string; chunk: number; reason: string }> = [];
  for (const f of parsed.findings) {
    const chunk = chunks[f.chunk - 1];
    if (!chunk) { dropped.push({ ...f, reason: "bad chunk number" }); continue; }
    if (!verifyQuote(chunk.text, f.quote)) { dropped.push({ ...f, reason: "quote not found verbatim" }); continue; }
    const q = f.question !== undefined && f.question >= 1 && f.question <= questions.length ? f.question : null;
    kept.push({ claim: f.claim, quote: f.quote, chunk_id: chunk.id, question: q });
  }
  return { kept, dropped };
}

export type SupportedFinding = VerifiedFinding & {
  source_id: string; site: string; type: SourceType; url: string; rating: Rating; outcome: string;
};

// ---------- full pipeline ----------

export async function runResearch(db: Database.Database, idea: Idea, deps: ResearchDeps) {
  const log = deps.log ?? (() => {});
  const ensureOwned = () => { if (deps.stillOwned && !deps.stillOwned()) throw new Error("Lease lost during research"); };
  const sources = createResearchSourceStore(db);
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, since: number) => { timings[k] = Date.now() - since; return Date.now(); };

  // 1. Queries
  let t = Date.now();
  const { questions, queries, fallback, queryFallback } = await generateQueries(idea, deps);
  t = mark("queries_ms", t);
  log(`questions: ${JSON.stringify(questions)}`);
  log(`queries: ${JSON.stringify(queries)}`);

  // 2. Search
  const lists: SearchHit[][] = [];
  let searchErrors = 0;
  for (const q of queries) {
    try { lists.push(await deps.search(q)); }
    catch (e) { searchErrors++; lists.push([]); log(`search failed for ${JSON.stringify(q)}: ${String(e).slice(0, 200)}`); }
  }
  const candidates = pickCandidates(lists, LIMITS.maxCandidates);
  t = mark("search_ms", t);
  ensureOwned();

  // 3. Fetch + save (network outside tx; each save is its own short tx)
  const sourceIds: string[] = [];
  const sourceUrl = new Map<string, string>();
  const sourceMeta = new Map<string, { site: string; type: SourceType }>();
  const sourcesDetail: Array<{ url: string; site: string; type: SourceType; query: number; used: boolean; error: string | null }> = [];
  let fetched = 0, fetchFailed = 0, sourcesInUse = 0;
  for (const c of candidates) {
    if (fetched >= LIMITS.maxSources) break;
    const res = await deps.fetch(c.url);
    if (res.error) { fetchFailed++; log(`fetch failed ${c.url}: ${res.error}`); }
    let id: string | undefined;
    try { id = sources.saveSource(idea.id, res).id; }   // failures are recorded in the error column
    catch (e) {
      if (!(e instanceof SourceInUseError)) throw e;
      sourcesInUse++;
      id = (db.prepare(`SELECT id FROM research_sources WHERE idea_id = ? AND url = ?`).get(idea.id, res.url) as { id: string } | undefined)?.id;
      log(`source in use, keeping existing chunks: ${c.url}`);
    }
    // Usable if it has chunks (fresh, unchanged, kept after a failed refetch, or in use).
    if (id && db.prepare(`SELECT 1 FROM research_chunks WHERE source_id = ? LIMIT 1`).get(id)) {
      fetched++; sourceIds.push(id); sourceUrl.set(id, res.final_url ?? res.url);
      sourceMeta.set(id, { site: c.site, type: c.type });
      sourcesDetail.push({ url: c.url, site: c.site, type: c.type, query: c.query + 1, used: true, error: res.error });
    } else {
      sourcesDetail.push({ url: c.url, site: c.site, type: c.type, query: c.query + 1, used: false, error: res.error });
    }
  }
  t = mark("fetch_ms", t);
  ensureOwned();

  // 4. Embed missing chunks (model call outside tx), then rank
  const chunkRows = sourceIds.length ? db.prepare(`
    SELECT id, source_id, text, embedding FROM research_chunks
    WHERE source_id IN (${sourceIds.map(() => "?").join(",")}) ORDER BY source_id, idx
  `).all(...sourceIds) as Array<{ id: string; source_id: string; text: string; embedding: Buffer | null }> : [];
  const missing = chunkRows.filter(r => !r.embedding);
  const setEmbedding = db.prepare(`UPDATE research_chunks SET embedding = ? WHERE id = ? AND embedding IS NULL`);
  let chunksEmbedded = 0;
  for (let i = 0; i < missing.length; i += LIMITS.embedBatch) {
    const batch = missing.slice(i, i + LIMITS.embedBatch);
    const vecs = await deps.embed(batch.map(r => r.text));
    const save = db.transaction(() => { batch.forEach((r, j) => { r.embedding = toBlob(vecs[j]!); setEmbedding.run(r.embedding, r.id); }); });
    save.immediate();
    chunksEmbedded += batch.length;
  }
  const [ideaVec] = await deps.embed([`${idea.title}\n${idea.content}`]);
  const ranked: RankedChunk[] = chunkRows
    .map(r => {
      const meta = sourceMeta.get(r.source_id) ?? { site: r.source_id, type: "blog" as SourceType };
      return { id: r.id, source_id: r.source_id, site: meta.site, type: meta.type, text: r.text,
        url: sourceUrl.get(r.source_id) ?? "", score: cosine(ideaVec!, fromBlob(r.embedding!)) + TYPE_BOOST[meta.type] };
    });
  const top = selectTopChunks(ranked, LIMITS.topChunks, LIMITS.maxChunksPerSite);
  t = mark("embed_ms", t);
  ensureOwned();

  // 5. Synthesis + verification
  let kept: VerifiedFinding[] = [];
  let dropped: Array<{ claim: string; quote: string; chunk: number; reason: string }> = [];
  let synthesisError: string | null = null;
  if (top.length) {
    try { ({ kept, dropped } = await synthesize(idea, top, deps, questions)); }
    catch (e) { synthesisError = String(e).slice(0, 300); log(`synthesis failed: ${synthesisError}`); }
  }
  t = mark("synthesis_ms", t);
  ensureOwned();

  // 6a. Quote reuse: keep only the first use of a quote
  const seenQuotes = new Set<string>();
  const unique: VerifiedFinding[] = [];
  let droppedReusedQuote = 0;
  for (const f of kept) {
    const key = normalizeForDedupe(f.quote);
    if (seenQuotes.has(key)) { droppedReusedQuote++; continue; }
    seenQuotes.add(key);
    unique.push(f);
  }

  // 6b. Support + "answers its question" check (one call); keep supported=yes AND answers=yes
  const qText = (f: VerifiedFinding) => f.question ? questions[f.question - 1]! : null;
  const support = await checkSupport(idea, unique.map(f => ({ claim: f.claim, quote: f.quote, question: qText(f) })), deps);
  const chunkOf = new Map(top.map(c => [c.id, c]));
  const perSite = new Map<string, number>();
  const checked: SupportedFinding[] = unique.map((f, i) => {
    const rating = support.ratings[i]!;
    const c = chunkOf.get(f.chunk_id)!;
    let outcome: string;
    if (rating === "unchecked") outcome = "unchecked";
    else if (rating.supported === "no") outcome = "unsupported";
    else if (rating.supported === "partial") outcome = "partial";
    else if (rating.answers !== "yes") outcome = "low_relevance";
    else {
      // 6c. Per-site cap on kept findings, in model order
      const n = perSite.get(c.site) ?? 0;
      outcome = n >= LIMITS.maxFindingsPerSite ? "source_cap" : "kept";
      if (outcome === "kept") perSite.set(c.site, n + 1);
    }
    return { ...f, source_id: c.source_id, site: c.site, type: c.type, url: c.url, rating, outcome };
  });
  const accepted = checked.filter(f => f.outcome === "kept");
  mark("support_ms", t);
  timings.total_ms = Date.now() - t0;

  const count = (o: string) => checked.filter(f => f.outcome === o).length;
  return {
    findings: accepted.map(f => ({ claim: f.claim, quote: f.quote, chunk_id: f.chunk_id })),
    checked,
    dropped,
    result: {
      questions, queries, queryFallback: fallback, queryFallbackKind: queryFallback, searchErrors,
      candidates: candidates.length, sources: sourceIds.length, fetched, fetchFailed, sourcesInUse,
      chunksTotal: chunkRows.length, chunksEmbedded, rankedChunks: top.length,
      rankedSources: new Set(top.map(c => c.source_id)).size,
      distinctSites: new Set(sourcesDetail.filter(d => d.used).map(d => d.site)).size,
      rankedSites: new Set(top.map(c => c.site)).size,
      keptSites: new Set(accepted.map(f => f.site)).size,
      sourcesDetail,
      quotesVerified: kept.length, findingsDropped: dropped.length,
      droppedReusedQuote, droppedUnsupported: count("unsupported"), droppedPartial: count("partial"),
      droppedUnchecked: count("unchecked"), droppedLowRelevance: count("low_relevance"), droppedSourceCap: count("source_cap"),
      supportAttempts: support.attempts, supportError: support.error,
      findingsKept: accepted.length, synthesisError,
      findingsDetail: checked.map(f => ({
        claim: f.claim, url: f.url, site: f.site, type: f.type, question: f.question, questionText: qText(f),
        support: f.rating === "unchecked" ? "unchecked" : f.rating.supported,
        answers: f.rating === "unchecked" ? "unchecked" : f.rating.answers, outcome: f.outcome
      })),
      timings
    }
  };
}

// ---------- default (live) deps ----------

export function searxngSearch(baseUrl = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888") {
  return async (query: string): Promise<SearchHit[]> => {
    const u = new URL("/search", baseUrl);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
    const data = await res.json() as { results?: Array<{ url?: string; title?: string }> };
    return (data.results ?? []).filter(r => typeof r.url === "string").map(r => ({ url: r.url!, title: r.title ?? "" }));
  };
}

export const liveFetch = (url: string) => fetchSource(url);
