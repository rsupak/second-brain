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

export type ResearchDeps = {
  search: (query: string) => Promise<SearchHit[]>;
  fetch: (url: string) => Promise<FetchResult>;
  embed: (texts: string[]) => Promise<number[][]>;
  llm: (messages: ChatMessage[], opts: { format: "json"; temperature: number; numPredict: number; numCtx?: number }) => Promise<string>;
  log?: (msg: string) => void;
  /** Return false to abort early (lease lost). */
  stillOwned?: () => boolean;
};

export const LIMITS = { maxQueries: 5, maxSources: 5, maxCandidates: 10, topChunks: 6, maxChunksPerSource: 2, embedBatch: 16 };

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

/** Round-robin across query result lists, dedupe, http(s) only. */
export function pickCandidates(lists: SearchHit[][], max: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (let i = 0; out.length < max && lists.some(l => i < l.length); i++) {
    for (const list of lists) {
      const hit = list[i];
      if (!hit) continue;
      const url = normalizeUrl(hit.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, title: hit.title });
      if (out.length >= max) break;
    }
  }
  return out;
}

// ---------- step 1: queries ----------

const QueriesSchema = z.object({ queries: z.array(z.string().trim().min(3).max(200)).min(1) });

export async function generateQueries(idea: Idea, deps: ResearchDeps): Promise<{ queries: string[]; fallback: boolean }> {
  const fallback = [idea.title];
  try {
    const raw = await deps.llm([
      { role: "system", content: `You write web search queries to find evidence about an engineering idea.
Return ONLY JSON: {"queries": ["...", "..."]} with 3 to 5 short, specific search queries.
Focus on technical facts, existing projects, hardware capabilities and limitations.
No markdown, no commentary.` },
      // Plain text, not JSON: given a JSON user message, qwen3:4b tends to echo it back.
      { role: "user", content: `Idea title: ${idea.title}\nDescription: ${idea.content}\n\nWrite 3 to 5 web search queries for this idea as {"queries": [...]}.` }
    ], { format: "json", temperature: 0, numPredict: 300 });
    const parsed = QueriesSchema.parse(extractJsonObject(raw));
    const uniq = [...new Set(parsed.queries.map(q => q.trim()))].slice(0, LIMITS.maxQueries);
    return { queries: uniq.length ? uniq : fallback, fallback: false };
  } catch (e) {
    deps.log?.(`query generation failed, falling back to title: ${String(e).slice(0, 200)}`);
    return { queries: fallback, fallback: true };
  }
}

// ---------- step 5: synthesis ----------

const FindingsSchema = z.object({
  findings: z.array(z.object({
    claim: z.string().trim().min(1),
    quote: z.string().trim().min(1),
    chunk: z.number().int()
  }))
});

export type RankedChunk = { id: string; source_id: string; text: string; url: string; score: number };

/** Highest-scoring chunks, at most `perSource` from any one source, `total` overall. */
export function selectTopChunks(chunks: RankedChunk[], total: number, perSource: number): RankedChunk[] {
  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const perCount = new Map<string, number>();
  const out: RankedChunk[] = [];
  for (const c of sorted) {
    if (out.length >= total) break;
    const n = perCount.get(c.source_id) ?? 0;
    if (n >= perSource) continue;
    perCount.set(c.source_id, n + 1);
    out.push(c);
  }
  return out;
}

// ---------- claim support check ----------

const SupportSchema = z.object({
  results: z.array(z.object({
    index: z.number().int(),
    supported: z.enum(["yes", "partial", "no"])
  }))
});

export type SupportLevel = "yes" | "partial" | "no";

/**
 * One batched LLM call rating each claim against its quote.
 * Invalid output is retried once; if still invalid, every finding is "unchecked" (dropped by the caller).
 * A finding the model does not rate is also "unchecked".
 */
export async function checkSupport(
  findings: Array<{ claim: string; quote: string }>, deps: ResearchDeps
): Promise<{ levels: Array<SupportLevel | "unchecked">; attempts: number; error: string | null }> {
  if (findings.length === 0) return { levels: [], attempts: 0, error: null };
  const items = findings.map((f, i) => ({ index: i + 1, claim: f.claim, quote: f.quote }));
  let error: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await deps.llm([
        { role: "system", content: `You rate whether each quote supports its claim.
For each item answer:
- "yes": the quote alone fully states the claim; nothing in the claim goes beyond the quote.
- "partial": the quote supports only part of the claim, or the claim adds details, specifics or certainty not in the quote.
- "no": the quote does not support the claim.
Be strict. Judge only from the quote text.
Return ONLY JSON: {"results": [{"index": N, "supported": "yes"|"partial"|"no"}]} with one entry per item.` },
        { role: "user", content: items.map(it => `ITEM ${it.index}\nCLAIM: ${it.claim}\nQUOTE: ${it.quote}`).join("\n\n") }
      ], { format: "json", temperature: 0, numPredict: 400, numCtx: 4096 });
      const parsed = SupportSchema.parse(extractJsonObject(raw));
      const byIndex = new Map(parsed.results.map(r => [r.index, r.supported]));
      return { levels: items.map(it => byIndex.get(it.index) ?? "unchecked"), attempts: attempt, error: null };
    } catch (e) {
      error = String(e).slice(0, 300);
      deps.log?.(`support check attempt ${attempt} invalid: ${error.slice(0, 160)}`);
    }
  }
  return { levels: items.map(() => "unchecked"), attempts: 2, error };
}

export async function synthesize(idea: Idea, chunks: RankedChunk[], deps: ResearchDeps) {
  const numbered = chunks.map((c, i) => `[${i + 1}] (source: ${c.url})\n${c.text}`).join("\n\n");
  const raw = await deps.llm([
    { role: "system", content: `You extract evidence about an engineering idea from numbered source excerpts.
Return ONLY JSON: {"findings": [{"claim": "...", "quote": "...", "chunk": N}]}
Rules:
- "quote" MUST be copied verbatim, character for character, from excerpt N. Do not paraphrase, shorten with ellipses, or fix typos.
- Each quote must be ONE contiguous sentence or fragment copied exactly as it appears in the excerpt.
- Never merge list items, bullet points or separate lines into one quote; never add or remove punctuation.
- Keep each quote to one or two sentences.
- "claim" is a short factual statement that the quote directly supports and that is relevant to the idea.
- "chunk" is the number of the excerpt containing the quote.
- Use only the excerpts. If nothing is relevant, return {"findings": []}.
- At most 8 findings. No markdown, no commentary.` },
    { role: "user", content: `IDEA: ${idea.title}\n${idea.content}\n\nEXCERPTS:\n${numbered}` }
  ], { format: "json", temperature: 0, numPredict: 1200, numCtx: 8192 });

  const parsed = FindingsSchema.parse(extractJsonObject(raw));
  const kept: NewFinding[] = [];
  const dropped: Array<{ claim: string; quote: string; chunk: number; reason: string }> = [];
  for (const f of parsed.findings) {
    const chunk = chunks[f.chunk - 1];
    if (!chunk) { dropped.push({ ...f, reason: "bad chunk number" }); continue; }
    if (!verifyQuote(chunk.text, f.quote)) { dropped.push({ ...f, reason: "quote not found verbatim" }); continue; }
    kept.push({ claim: f.claim, quote: f.quote, chunk_id: chunk.id });
  }
  return { kept, dropped };
}

export type SupportedFinding = NewFinding & { support: SupportLevel | "unchecked" };

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
  const { queries, fallback } = await generateQueries(idea, deps);
  t = mark("queries_ms", t);
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
    .map(r => ({ id: r.id, source_id: r.source_id, text: r.text, url: sourceUrl.get(r.source_id) ?? "", score: cosine(ideaVec!, fromBlob(r.embedding!)) }));
  const top = selectTopChunks(ranked, LIMITS.topChunks, LIMITS.maxChunksPerSource);
  t = mark("embed_ms", t);
  ensureOwned();

  // 5. Synthesis + verification
  let kept: NewFinding[] = [];
  let dropped: Array<{ claim: string; quote: string; chunk: number; reason: string }> = [];
  let synthesisError: string | null = null;
  if (top.length) {
    try { ({ kept, dropped } = await synthesize(idea, top, deps)); }
    catch (e) { synthesisError = String(e).slice(0, 300); log(`synthesis failed: ${synthesisError}`); }
  }
  t = mark("synthesis_ms", t);
  ensureOwned();

  // 6. Claim support check: keep only "yes"
  const support = await checkSupport(kept, deps);
  const checked: SupportedFinding[] = kept.map((f, i) => ({ ...f, support: support.levels[i]! }));
  const accepted = checked.filter(f => f.support === "yes");
  const rejected = checked.filter(f => f.support !== "yes");
  mark("support_ms", t);
  timings.total_ms = Date.now() - t0;

  const count = (lvl: string) => rejected.filter(f => f.support === lvl).length;
  return {
    findings: accepted.map(({ support: _s, ...f }) => f),
    checked,
    dropped,
    result: {
      queries, queryFallback: fallback, searchErrors,
      candidates: candidates.length, sources: sourceIds.length, fetched, fetchFailed, sourcesInUse,
      chunksTotal: chunkRows.length, chunksEmbedded, rankedChunks: top.length,
      rankedSources: new Set(top.map(c => c.source_id)).size,
      quotesVerified: kept.length, findingsDropped: dropped.length,
      droppedUnsupported: count("no"), droppedPartial: count("partial"), droppedUnchecked: count("unchecked"),
      supportAttempts: support.attempts, supportError: support.error,
      findingsKept: accepted.length, synthesisError, timings
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
