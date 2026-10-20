// Deep dive for a skill: the research pipeline (runResearch) with bigger settings, then a gemma4 write-up
// that may only use the verified findings. Key facts are built in code from verified findings (never by the model).
// Related ideas/skills come from embedding similarity. Pure orchestration with injectable deps for tests.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  LIMITS, SYNTH_MODEL, runResearch, extractJsonObject, cosine, toBlob, fromBlob, siteKey, sourceType,
  type Idea, type ResearchDeps
} from "./research.js";
import type { SkillSection, SkillVersionInput } from "./skill-jobs.js";

export const EMBED_MODEL = "qwen3-embedding:0.6b";
export const WRITEUP_MODEL = process.env.DEEP_DIVE_MODEL ?? SYNTH_MODEL;

/** Bigger research budgets for a deep dive (normal research: 3-5 questions, 5 sources, 8 excerpts). */
export const DEEP_LIMITS: Partial<typeof LIMITS> = {
  minQuestions: 8, maxQueries: 10, maxSources: 12, maxCandidates: 30, maxCandidatesPerSite: 2,
  chunksPerQuestion: 2, maxExcerpts: 16, maxChunksPerSite: 3, maxFindingsPerSite: 3,
  maxExcerptChars: 1200, maxExcerptTotalChars: 24000, maxFindings: 16,
  synthNumPredict: 2600, synthNumCtx: 12288, judgeNumPredict: 1600,
  // qwen3:4b hits Ollama's token-repeat limit when asked for 8-10 questions; gemma4 handles the longer lists.
  questionsNumPredict: 1000, queriesNumPredict: 700, questionModel: process.env.DEEP_DIVE_QUESTION_MODEL ?? SYNTH_MODEL
};

/** Runs fn with LIMITS temporarily raised. The deep-dive worker is its own process and runs one job at a time. */
export async function withDeepLimits<T>(fn: () => Promise<T>, limits = DEEP_LIMITS): Promise<T> {
  const saved = { ...LIMITS };
  Object.assign(LIMITS, limits);
  try { return await fn(); } finally { Object.assign(LIMITS, saved); }
}

export type Fact = { n: number; claim: string; quote: string; chunk_id: string; source_id: string; url: string; title: string | null; question: string | null };

const WriteupSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  overview: z.string().trim().min(1).max(4000),
  how_it_works: z.string().trim().max(5000).default(""),
  practical_steps: z.array(z.string().trim().min(1).max(600)).max(12).default([]),
  open_questions: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).default([])
});
export type Writeup = z.infer<typeof WriteupSchema>;

/** Removes [F#] citations that point at facts that do not exist; returns the cited fact numbers. */
export function checkCitations(text: string, factCount: number): { text: string; cited: number[]; removed: number } {
  const cited = new Set<number>(); let removed = 0;
  const out = text.replace(/\[F(\d+)\]/g, (m, d) => { const n = Number(d); if (n >= 1 && n <= factCount) { cited.add(n); return m; } removed++; return ""; });
  return { text: out.replace(/ {2,}/g, " ").trim(), cited: [...cited].sort((a, b) => a - b), removed };
}

export function writeupPrompt(idea: Idea, facts: Fact[], questions: string[]) {
  const system = `You write a concise study guide ("skill") about a topic for a personal knowledge library.
You are given numbered VERIFIED FACTS, each backed by a quoted source. They are the ONLY facts you may state.
Rules:
- Do not state any fact, number, name, product, date or claim that is not in the VERIFIED FACTS. If something is unknown, say it is unknown or put it in open_questions.
- When a sentence relies on a fact, cite it like [F3]. Cite only fact numbers that exist.
- "overview": 2 to 4 sentences on what the topic is and why it matters, grounded in the facts.
- "how_it_works": one or two short paragraphs explaining the mechanism, only as far as the facts support.
- "practical_steps": 3 to 7 concrete next steps someone could take to apply or test the idea. Steps are advice, not facts; do not invent specs.
- "open_questions": 3 to 7 important things the facts do NOT answer.
- "summary": one sentence describing the skill.
- "tags": 2 to 5 short lowercase topic tags (one or two words each), e.g. "gardening", "habit tracking".
Return ONLY JSON: {"summary": "...", "overview": "...", "how_it_works": "...", "practical_steps": ["..."], "open_questions": ["..."], "tags": ["..."]}. No markdown.`;
  const user = `TOPIC: ${idea.title}\n${idea.content}\n\nRESEARCH QUESTIONS:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n") || "(none)"}\n\nVERIFIED FACTS:\n${
    facts.length ? facts.map(f => `[F${f.n}] ${f.claim}`).join("\n") : "(none)"}`;
  return { system, user };
}

export async function writeUp(idea: Idea, facts: Fact[], questions: string[], deps: Pick<ResearchDeps, "llm" | "log">) {
  const { system, user } = writeupPrompt(idea, facts, questions);
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw = await deps.llm([{ role: "system", content: system }, { role: "user", content: user }],
        { format: "json", temperature: 0.2, numPredict: 2000, numCtx: 8192, model: WRITEUP_MODEL });
      return { writeup: WriteupSchema.parse(extractJsonObject(raw)), attempts: attempt };
    } catch (e) { lastErr = String(e).slice(0, 300); deps.log?.(`write-up attempt ${attempt} invalid: ${lastErr}`); }
  }
  throw new Error(`Write-up failed: ${lastErr}`);
}

const hashText = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Embeds (cached) every idea except the skill's own, plus other skills; returns the most similar ones. */
export async function findRelated(db: Database.Database, skillId: string, ideaId: string, vec: ArrayLike<number>,
  embed: ResearchDeps["embed"], opts = { ideas: 5, skills: 4, minSim: 0.45 }) {
  const ideas = db.prepare(`SELECT id, title, content FROM ideas WHERE id != ?`).all(ideaId) as Array<{ id: string; title: string; content: string }>;
  const cached = new Map((db.prepare(`SELECT idea_id, content_hash, vector FROM idea_embeddings WHERE model = ?`).all(EMBED_MODEL) as Array<{ idea_id: string; content_hash: string; vector: Buffer }>)
    .map(r => [r.idea_id, r]));
  const todo = ideas.filter(i => cached.get(i.id)?.content_hash !== hashText(`${i.title}\n${i.content}`));
  const save = db.prepare(`INSERT INTO idea_embeddings (idea_id, model, content_hash, vector) VALUES (?, ?, ?, ?)
    ON CONFLICT(idea_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, vector = excluded.vector`);
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16);
    const vecs = await embed(batch.map(x => `${x.title}\n${x.content}`));
    db.transaction(() => batch.forEach((x, j) => {
      const h = hashText(`${x.title}\n${x.content}`), b = toBlob(vecs[j]!);
      save.run(x.id, EMBED_MODEL, h, b); cached.set(x.id, { idea_id: x.id, content_hash: h, vector: b });
    })).immediate();
  }
  const relIdeas = ideas.map(i => ({ id: i.id, title: i.title, similarity: cosine(vec, fromBlob(cached.get(i.id)!.vector)) }))
    .filter(r => r.similarity >= opts.minSim).sort((a, b) => b.similarity - a.similarity).slice(0, opts.ideas)
    .map(r => ({ ...r, similarity: Number(r.similarity.toFixed(3)) }));
  const relSkills = (db.prepare(`SELECT e.skill_id AS id, s.title, e.vector FROM skill_embeddings e JOIN skills s ON s.id = e.skill_id WHERE e.skill_id != ? AND e.model = ?`)
    .all(skillId, EMBED_MODEL) as Array<{ id: string; title: string; vector: Buffer }>)
    .map(r => ({ id: r.id, title: r.title, similarity: cosine(vec, fromBlob(r.vector)) }))
    .filter(r => r.similarity >= opts.minSim).sort((a, b) => b.similarity - a.similarity).slice(0, opts.skills)
    .map(r => ({ ...r, similarity: Number(r.similarity.toFixed(3)) }));
  return { ideas: relIdeas, skills: relSkills };
}

/** Assembles sections. Only Key facts are "verified"; prose sections are labelled "synthesis"; related is "computed". */
export function buildSections(w: Writeup | null, facts: Fact[], unanswered: string[], related: { ideas: unknown[]; skills: unknown[] }) {
  const n = facts.length;
  const c = (t: string) => checkCitations(t, n);
  const overview = w ? c(w.overview) : { text: "No verified facts were found, so no overview was written.", cited: [], removed: 0 };
  const how = w ? c(w.how_it_works) : { text: "", cited: [], removed: 0 };
  const steps = (w?.practical_steps ?? []).map(c);
  const openQs = [...new Set([...(w?.open_questions ?? []), ...unanswered])].slice(0, 12);
  const sections: SkillSection[] = [
    { key: "overview", title: "Overview", kind: "synthesis", text: overview.text },
    { key: "how_it_works", title: "How it works", kind: "synthesis", text: how.text },
    { key: "key_facts", title: "Key facts", kind: "verified", items: facts.map(f => ({
      n: f.n, claim: f.claim, quote: f.quote, url: f.url, title: f.title, site: siteKey(f.url), sourceType: sourceType(f.url), question: f.question })) },
    { key: "practical_steps", title: "Practical steps", kind: "synthesis", items: steps.map(s => s.text) },
    { key: "open_questions", title: "Open questions", kind: "synthesis", items: openQs },
    { key: "related", title: "Related ideas", kind: "computed", items: [{ ideas: related.ideas, skills: related.skills }] }
  ];
  const citedFacts = new Set([...overview.cited, ...how.cited, ...steps.flatMap(s => s.cited)]);
  const removedCitations = overview.removed + how.removed + steps.reduce((a, s) => a + s.removed, 0);
  return { sections, citedFacts: [...citedFacts].sort((a, b) => a - b), removedCitations };
}

export async function runDeepDive(db: Database.Database, skillId: string, idea: Idea, deps: ResearchDeps): Promise<SkillVersionInput> {
  const log = deps.log ?? (() => {});
  const t0 = Date.now();
  const research = await withDeepLimits(() => runResearch(db, idea, deps));
  const tResearch = Date.now() - t0;
  const r = research.result as Record<string, any>;
  const questions: string[] = r.questions ?? [];
  // Verified + judged findings only (runResearch keeps quote-verified, support=yes, on-question claims).
  const kept = research.checked.filter(f => f.outcome === "kept");
  const titleOf = db.prepare(`SELECT title FROM research_sources WHERE id = ?`).pluck();
  const facts: Fact[] = kept.map((f, i) => ({ n: i + 1, claim: f.claim, quote: f.quote, chunk_id: f.chunk_id, source_id: f.source_id,
    url: f.url, title: (titleOf.get(f.source_id) as string | null) ?? null, question: f.question ? questions[f.question - 1] ?? null : null }));
  const answered = new Set(facts.map(f => f.question).filter(Boolean));
  const unanswered = questions.filter(q => !answered.has(q));
  if (deps.stillOwned && !deps.stillOwned()) throw new Error("Lease lost during deep dive");

  let t = Date.now();
  let w: Writeup | null = null, writeupAttempts = 0;
  if (facts.length) ({ writeup: w, attempts: writeupAttempts } = await writeUp(idea, facts, questions, deps));
  else log("no verified facts: skipping the model write-up so nothing is invented");
  const tWriteup = Date.now() - t;

  t = Date.now();
  const summary = w?.summary ?? `Deep dive on "${idea.title}" (no verified facts found yet).`;
  const tags = [...new Set((w?.tags ?? []).map(x => x.toLowerCase()))];
  const [vec] = await deps.embed([`${idea.title}\n${summary}\n${tags.join(", ")}`]);
  const related = await findRelated(db, skillId, idea.id, vec!, deps.embed);
  const tRelated = Date.now() - t;

  const { sections, citedFacts, removedCitations } = buildSections(w, facts, unanswered, related);
  const usedUrls = (r.sourcesDetail as Array<{ url: string; used: boolean }> ?? []).filter(d => d.used).map(d => d.url);
  const findId = db.prepare(`SELECT id FROM research_sources WHERE idea_id = ? AND (url = ? OR final_url = ?)`).pluck();
  const sourceIds = new Set<string>(usedUrls.map(u => findId.get(idea.id, u, u) as string | undefined).filter((x): x is string => !!x));
  facts.forEach(f => sourceIds.add(f.source_id));
  const citedSources = new Set(facts.map(f => f.source_id));
  const len = (s: SkillSection) => s.text != null ? s.text.length : JSON.stringify(s.items ?? []).length;
  const stats = {
    total_ms: Date.now() - t0, research_ms: tResearch, writeup_ms: tWriteup, related_ms: tRelated,
    questions: questions.length, queries: (r.queries ?? []).length, sourcesFetched: r.fetched, fetchFailed: r.fetchFailed,
    quotesVerified: r.quotesVerified, verifiedFacts: facts.length, droppedUnsupported: r.droppedUnsupported, droppedPartial: r.droppedPartial,
    droppedNoQuestion: r.droppedNoQuestion, droppedSourceCap: r.droppedSourceCap, synthesisError: r.synthesisError ?? null,
    citedFacts: citedFacts.length, removedCitations, writeupAttempts, writeupModel: w ? WRITEUP_MODEL : null, synthModel: SYNTH_MODEL,
    sectionChars: Object.fromEntries(sections.map(s => [s.key, len(s)])), researchTimings: r.timings
  };
  return {
    summary, sections, tags, stats,
    findings: facts.map(f => ({ claim: f.claim, quote: f.quote, chunk_id: f.chunk_id, question: f.question })),
    sources: [...sourceIds].map(id => ({ source_id: id, cited: citedSources.has(id) })),
    embedding: { model: EMBED_MODEL, vector: toBlob(vec!) }
  };
}
