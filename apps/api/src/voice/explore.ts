// Voice idea exploration: open/confirm/switch an idea, recap, grounded answers, notes, skill, evaluation, close + summary.
// Pure helpers (parseIntent, rankIdeas, decideMatch, buildContext, groundSummary) are unit-tested; Explorer wires them to the DB.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { capReply, stripReasoning } from "./filters.js";
import { parseCapture } from "./brain.js";
import { createConversationStore, loadIdeaVectors, IDLE_MS, type ConversationStore, type Session, type Turn } from "../conversations.js";
import { cosine, fromBlob } from "../research.js";

export type Intent =
  | { kind: "capture"; content: string }
  | { kind: "open"; query: string; verb: "open" | "switch"; strong: boolean }
  | { kind: "make_idea" }
  | { kind: "yes" } | { kind: "no" } | { kind: "pick"; index: number }
  | { kind: "note"; text: string }
  | { kind: "skill" } | { kind: "evaluation" } | { kind: "close" }
  | { kind: "question"; text: string };

const WAKE = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(?:(?:bailey|baily|bailie|bailee|bayley|baylee)[\s,.!]+)/i;
const clean = (s: string) => s.replace(WAKE, "").trim();
const bare = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/[.!?,;:]+/g, " ").replace(/\s+/g, " ").trim();

export function parseIntent(raw: string): Intent {
  const cap = parseCapture(raw);
  if (cap) return { kind: "capture", content: cap };
  const text = clean(raw); const b = bare(text);
  let m: RegExpExecArray | null;
  if (/^(?:(?:ok(?:ay)?|so|please) )?(?:make|turn) (?:this|that|it)(?: conversation| chat)? (?:into )?an idea\b|^(?:save|add) (?:this|that) as an idea\b/.test(b)) return { kind: "make_idea" };
  if ((m = /^(?:(?:ok(?:ay)?|now|and) )?(?:switch (?:over )?to|change to|jump to)\s+(.+)$/.exec(b))) return { kind: "open", query: strip(m[1]!), verb: "switch", strong: true };
  if ((m = /^(?:(?:ok(?:ay)?|so|now) )?(?:let'?s|let us|can we|i want to|i'd like to) (?:talk|chat|think) (?:about|through)\s+(.+)$/.exec(b))
   || (m = /^(?:(?:ok(?:ay)?|so) )?(?:let'?s )?(?:go )?back to\s+(.+)$/.exec(b))) return { kind: "open", query: strip(m[1]!), verb: "open", strong: true };
  // Bare "open X" / "resume X" only opens when X matches an idea above threshold; otherwise it is handled as a question.
  if ((m = /^(?:(?:ok(?:ay)?|so) )?(?:let'?s )?(?:open(?: up)?|resume|pick up|continue(?: with)?)\s+(.+)$/.exec(b))) return { kind: "open", query: strip(m[1]!), verb: "open", strong: false };
  if ((m = /^(?:please )?(?:add|at|and|had|take|make|save) (?:a |this )?note(?: that)?\s*[:,\-–—]?\s*(.+)$/i.exec(text.trim()))) return { kind: "note", text: m[1]!.trim() };
  if (/^(?:please )?(?:make|turn) (?:this|it|that)(?: idea)? (?:into )?a skill\b|^(?:add|save) (?:this|it) as a skill\b|^deep dive (?:on )?(?:this|it)\b/.test(b)) return { kind: "skill" };
  if (/\b(?:what(?:'s| is| are) (?:its|the|it's|this idea's) (?:evaluation|scores?|rating)|how (?:did|does) it score|read (?:me )?(?:its|the) (?:evaluation|scores))\b/.test(b)) return { kind: "evaluation" };
  if (/^(?:(?:ok(?:ay)?|alright) )?(?:close(?: (?:it|this|the idea|the session))?|(?:i'm |we're |i am |we are )?done(?: for now)?|that's all(?: for now)?|end (?:the )?session|stop exploring|goodbye|bye)$/.test(b)) return { kind: "close" };
  if (/^(?:yes|yeah|yep|yup|correct|right|exactly|sure|that's (?:it|the one|right)|that one)(?: (?:that's (?:it|the one|right)|please|thanks))?$/.test(b)) return { kind: "yes" };
  if (/^(?:no|nope|nah|not that(?: one)?|neither(?: of them)?|wrong(?: one)?)(?: .*)?$/.test(b) && b.split(" ").length <= 5) return { kind: "no" };
  if ((m = /^(?:the )?(first|second|1st|2nd|one|two|number one|number two)(?: one)?$/.exec(b))) return { kind: "pick", index: /first|1st|one$/.test(m[1]!) ? 0 : 1 };
  return { kind: "question", text };
}
function strip(q: string) { return q.replace(/^(?:the|my|our|that|this) (?:idea (?:about |of )?)?/, "").replace(/ (?:idea|one|again|please)$/, "").trim(); }

// ---------- matching ----------
export type Candidate = { id: string; title: string; contentVec?: ArrayLike<number> | null; titleVecs: ArrayLike<number>[] };
const STOP = new Set("the a an of for with and to in on my our that this idea about real time based".split(" "));
const toks = (s: string) => bare(s).split(" ").filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/s$/, ""));
export function lexical(query: string, title: string) { const q = toks(query); if (!q.length) return 0; const t = new Set(toks(title)); return q.filter(w => t.has(w)).length / q.length; }
export function rankIdeas(query: string, qv: ArrayLike<number>, cands: Candidate[]) {
  return cands.map(c => {
    const sims = [c.contentVec ? cosine(qv, c.contentVec) : -1, ...c.titleVecs.map(v => cosine(qv, v))];
    const sem = Math.max(...sims), lex = lexical(query, c.title);
    return { id: c.id, title: c.title, score: Number((0.8 * sem + 0.2 * lex).toFixed(4)), sem: Number(sem.toFixed(4)), lex };
  }).sort((a, b) => b.score - a.score);
}
export const MATCH = { confident: Number(process.env.VOICE_MATCH_CONFIDENT ?? 0.6), margin: Number(process.env.VOICE_MATCH_MARGIN ?? 0.05), floor: Number(process.env.VOICE_MATCH_FLOOR ?? 0.42) };
export function decideMatch(ranked: Array<{ id: string; title: string; score: number }>, t = MATCH): { kind: "confident" | "ambiguous" | "none"; top: typeof ranked } {
  const [a, b] = ranked;
  if (!a || a.score < t.floor) return { kind: "none", top: [] };
  if (a.score >= t.confident && (!b || a.score - b.score >= t.margin)) return { kind: "confident", top: ranked.slice(0, 2) };
  return { kind: "ambiguous", top: ranked.slice(0, 2).filter(x => x.score >= t.floor) };
}
export const QUERY_PREFIX = "Instruct: Given a spoken request, retrieve the matching idea\nQuery: ";

const content = (s: string) => toks(s).filter(w => w.length > 3);
// ---------- context ----------
// Facts below this similarity to the question are left out, so weakly related findings are not cited as "your research".
export const FACT_MIN_SIM = Number(process.env.VOICE_FACT_MIN_SIM ?? 0.45);
export type Fact = { tag: string; text: string; source: "research" | "skill"; sim: number };
export type IdeaContext = { title: string; content: string; evaluation: null | { feasibility: number; cost: number; relevance: number; novelty: number; summary: string }; facts: Fact[]; recent: Turn[]; summary: string | null };
export function buildContext(ctx: IdeaContext, question: string, mode: "voice" | "web" = "voice") {
  const e = ctx.evaluation;
  const lines = [`IDEA: ${ctx.title}`, `DESCRIPTION: ${ctx.content.slice(0, 700)}`];
  if (e) lines.push(`EVALUATION (1-5, cost 5 = cheapest): feasibility ${e.feasibility}, cost ${e.cost}, relevance ${e.relevance}, novelty ${e.novelty}. ${e.summary.slice(0, 300)}`);
  if (ctx.summary) lines.push(`EARLIER CONVERSATIONS: ${ctx.summary}`);
  if (ctx.facts.length) lines.push("VERIFIED FACTS FROM RICHARD'S RESEARCH:", ...ctx.facts.map(f => `[${f.tag}] ${f.text}`));
  if (ctx.recent.length) lines.push("RECENT CONVERSATION:", ...ctx.recent.map(t => `${t.role === "note" ? "NOTE" : t.role === "user" ? "Richard" : "Bailey"} (${t.channel}): ${t.text.slice(0, 300)}`));
  const system = "You are Bailey, Richard's local assistant. You are exploring one of Richard's ideas with him. " +
    (mode === "voice" ? "Answer in one to three short spoken sentences, plain text only." : "This is a text chat: answer in up to three short paragraphs of plain text (no markdown, no tables).") + " Use the context below. When you use a verified fact, put its tag such as [F1] right after it. " +
    "Do not invent research results; if the context doesn't cover the question, say so briefly and give a short general answer.\n\n" + lines.join("\n");
  return { system, user: question, factTags: ctx.facts.map(f => f.tag) };
}
/** A cited fact counts as used only if the citing sentence actually shares content words with it. */
export function citationUsed(sentence: string, fact: string, min = Number(process.env.VOICE_CITE_MIN_OVERLAP ?? 0.25)) {
  const f = new Set(content(fact)); const w = [...new Set(content(sentence.replace(/\[[^\]]*\]/g, " ")))];
  const shared = w.filter(x => f.has(x)).length;
  return shared >= 2 && shared / Math.max(1, Math.min(w.length, f.size)) >= min;
}
/** Strips [F#] tags; says what the answer is based on only when a cited fact is verifiably used by its sentence. */
export function finishGrounded(raw: string, facts: Fact[], opts: { cap?: boolean } = {}) {
  const used: string[] = [];
  for (const sent of raw.match(/[^.!?]+[.!?]*(?:\s*\[[^\]]*\])?/g) ?? []) {
    for (const m of sent.matchAll(/\[((?:F\d+(?:,\s*)?)+)\]/g)) for (const tag of m[1]!.split(/,\s*/)) {
      const f = facts.find(x => x.tag === tag);
      if (f && !used.includes(tag) && citationUsed(sent, f.text)) used.push(tag);
    }
  }
  let text = raw.replace(/\s*\[(?:F\d+(?:,\s*)?)+\]/g, "").replace(/\s*\[[A-Z][A-Z0-9 ,_-]*\]/g, "") /* stray [IDEA]-style labels */.replace(/\s+([.,!?])/g, "$1").trim();
  if (used.length && !/\b(research|based on|according to|findings?|sources?)\b/i.test(text)) {
    const kinds = new Set(used.map(t => facts.find(f => f.tag === t)!.source));
    text = `${kinds.has("research") ? "From your research" : "From the skill write-up"}: ${text}`;
  }
  return { text: opts.cap === false ? text : capReply(text), used };
}

// ---------- summary grounding ----------
/** Keeps only sentences whose content words mostly appear in the source (transcript + previous summary). */
export function groundSummary(summary: string, source: string, minOverlap = 0.5) {
  const src = new Set(content(source)); const kept: string[] = [], dropped: string[] = [];
  for (const s of (summary.match(/[^.!?]+[.!?]*/g) ?? []).map(x => x.trim()).filter(Boolean)) {
    const w = content(s); const ov = w.length ? w.filter(x => src.has(x)).length / w.length : 0;
    (ov >= minOverlap ? kept : dropped).push(s);
  }
  return { text: kept.join(" "), kept, dropped };
}

// ---------- Explorer ----------
export type LLM = (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, opts?: { numPredict?: number; temperature?: number }) => Promise<string>;
export type ExplorerDeps = {
  db: Database.Database; embed: (xs: string[]) => Promise<number[][]>; llm: LLM; model: string;
  captureIdea: (content: string) => Promise<{ id: string; title: string }>;
  createSkill: (ideaId: string) => Promise<{ status: number; body: any }>;
  /** Existing POST /ideas logic (auto-queues expansion, evaluation, research). */
  createIdea: (title: string, content: string) => Promise<{ id: string; title: string }>;
  /** Topic skill (no parent idea of Richard's): POST /skills/topic logic. */
  createTopicSkill: (topic: string, seed: string, sessionId: string | null) => Promise<{ status: number; body: any }>;
  generalAnswer: (q: string) => Promise<string>;
  now?: () => number; log?: (...a: unknown[]) => void; idleMs?: number;
};
type Pending = { kind: "confirm" | "choose"; candidates: Array<{ id: string; title: string }> }
  | { kind: "save_idea"; draft: IdeaDraft } | { kind: "save_skill"; proposal: SkillProposal };
export type IdeaDraft = { title: string; content: string };
export type SkillProposal = { mode: "idea" | "topic"; topic: string; seed: string; ideaId: string | null; ideaTitle: string | null; fit: number | null };
export const SKILL_FIT = Number(process.env.SKILL_FIT_MIN_SIM ?? 0.6);
const KEYWORD = /\b(make|turn) (this|that|it)\b.*\b(an idea|a skill)\b|\badd this as a skill\b/i;
export function parseJsonObject(s: string): any { const m = /\{[\s\S]*\}/.exec(s); if (!m) return null; try { return JSON.parse(m[0]); } catch { return null; } }
export type Reply = { reply: string; emotion: "neutral" | "happy" | "sad"; intent: string; sessionId?: string; ideaId?: string | null; timings?: Record<string, number> };

export function createExplorer(d: ExplorerDeps) {
  const now = d.now ?? Date.now, log = d.log ?? (() => {}), idleMs = d.idleMs ?? IDLE_MS;
  const store: ConversationStore = createConversationStore(d.db, now);
  const titleVecCache = new Map<string, number[]>(); const factVecCache = new Map<string, number[]>();
  const h = (s: string) => createHash("sha1").update(s).digest("hex");
  const pendingSummaries = new Set<Promise<unknown>>();

  async function cachedEmbed(texts: string[], cache: Map<string, number[]>) {
    const miss = [...new Set(texts.filter(t => !cache.has(h(t))))];
    if (miss.length) (await d.embed(miss)).forEach((v, i) => cache.set(h(miss[i]!), v));
    return texts.map(t => cache.get(h(t))!);
  }
  async function candidates(): Promise<Candidate[]> {
    const ideas = d.db.prepare(`SELECT id, title FROM ideas`).all() as Array<{ id: string; title: string }>;
    const vecs = loadIdeaVectors(d.db);
    const skills = d.db.prepare(`SELECT idea_id, title FROM skills`).all() as Array<{ idea_id: string; title: string }>;
    const titleVecs = await cachedEmbed([...ideas.map(i => i.title), ...skills.map(s => s.title)], titleVecCache);
    return ideas.map((i, k) => ({ id: i.id, title: i.title, contentVec: vecs.get(i.id) ?? null,
      titleVecs: [titleVecs[k]!, ...skills.flatMap((s, j) => s.idea_id === i.id ? [titleVecs[ideas.length + j]!] : [])] }));
  }
  async function match(query: string) {
    const [qv] = await d.embed([QUERY_PREFIX + query]);
    const ranked = rankIdeas(query, qv!, await candidates());
    return { ...decideMatch(ranked), ranked };
  }
  const ideaTitle = (id: string) => (d.db.prepare(`SELECT title FROM ideas WHERE id = ?`).pluck().get(id) as string | undefined) ?? "that idea";

  async function loadContext(ideaId: string, question: string, k = 4): Promise<IdeaContext> {
    const idea = d.db.prepare(`SELECT title, content FROM ideas WHERE id = ?`).get(ideaId) as { title: string; content: string };
    const evaluation = (d.db.prepare(`SELECT feasibility, cost, relevance, novelty, summary FROM idea_evaluations WHERE idea_id = ?`).get(ideaId) as IdeaContext["evaluation"]) ?? null;
    const research = (d.db.prepare(`SELECT claim FROM research_findings WHERE idea_id = ? AND verified = 1`).pluck().all(ideaId) as string[]).map(t => ({ text: t, source: "research" as const }));
    const skill = (d.db.prepare(`SELECT f.claim FROM skill_findings f JOIN skills s ON s.id = f.skill_id AND f.version = s.version WHERE s.idea_id = ? AND f.verified = 1`).pluck().all(ideaId) as string[]).map(t => ({ text: t, source: "skill" as const }));
    const all = [...research, ...skill];
    let facts: Fact[] = [];
    if (all.length) {
      const [qv] = await d.embed([question]); const fv = await cachedEmbed(all.map(f => f.text), factVecCache);
      facts = all.map((f, i) => ({ ...f, sim: cosine(qv!, fv[i]!) })).filter(f => f.sim >= FACT_MIN_SIM).sort((a, b) => b.sim - a.sim).slice(0, k).map((f, i) => ({ ...f, tag: `F${i + 1}` }));
    }
    return { title: idea.title, content: idea.content, evaluation, facts, recent: store.recentForIdea(ideaId, 6), summary: store.getSummary(ideaId)?.summary ?? null };
  }

  async function recap(ideaId: string): Promise<string> {
    const title = ideaTitle(ideaId); const summary = store.getSummary(ideaId)?.summary; const recent = store.recentForIdea(ideaId, 6);
    if (!summary && !recent.length) return capReply(`Okay, ${title}. We haven't talked about this one yet. What would you like to explore?`);
    const raw = await d.llm([{ role: "system", content: "You are Bailey, a voice assistant. In one or two short spoken sentences, remind Richard where you left off on this idea. Use only the notes below; plain text, no lists." },
      { role: "user", content: `IDEA: ${title}\n${summary ? `SUMMARY: ${summary}\n` : ""}LAST MESSAGES:\n${recent.map(t => `${t.role === "note" ? "NOTE" : t.role === "user" ? "Richard" : "Bailey"} (${t.channel}): ${t.text.slice(0, 300)}`).join("\n")}` }],
      { numPredict: 90, temperature: 0.3 });
    return capReply(`Okay, ${title}. ${capReply(raw, 2, 220)}`);
  }

  async function summarize(sessionId: string) {
    const s = store.getSession(sessionId); if (!s?.idea_id) return null;
    const turns = store.turns(sessionId).filter(t => t.role !== "assistant" || t.text.length > 0);
    if (!turns.some(t => t.role === "user" || t.role === "note")) return null;
    const prev = store.getSummary(s.idea_id)?.summary ?? "";
    const transcript = turns.map(t => `${t.role === "note" ? "NOTE" : t.role === "user" ? "Richard" : "Bailey"}: ${t.text}`).join("\n");
    const raw = await d.llm([{ role: "system", content: "Update the running summary of Richard's conversations about one idea. At most four plain sentences: what was discussed, notes he added, decisions and open questions. " +
      "Use only facts stated in the previous summary or the transcript; do not add anything new. Write about Richard in the third person." },
      { role: "user", content: `IDEA: ${ideaTitle(s.idea_id)}\nPREVIOUS SUMMARY: ${prev || "(none)"}\nTRANSCRIPT:\n${transcript}` }], { numPredict: 200, temperature: 0.2 });
    const g = groundSummary(raw.replace(/\s+/g, " ").trim(), `${ideaTitle(s.idea_id)} ${prev} ${transcript}`);
    if (g.dropped.length) log("summary dropped ungrounded", JSON.stringify(g.dropped));
    const text = g.text || prev;
    if (text) store.putSummary(s.idea_id, text, d.model, sessionId);
    return { summary: text, dropped: g.dropped };
  }
  function endSession(s: Session, reason: string) {
    if (!store.endSession(s.id, reason)) return;
    const p = summarize(s.id).catch(e => log("summary failed", e)).finally(() => pendingSummaries.delete(p)); pendingSummaries.add(p);
  }
  function sweepIdle() { for (const s of store.idleSessions(idleMs)) { log("session idle timeout", s.id); endSession(s, "timeout"); } }

  const speaker = (t: Turn) => t.role === "note" ? "NOTE" : t.role === "user" ? "Richard" : "Bailey";
  const transcriptOf = (sessionId: string, max = 16) => store.turns(sessionId).filter(t => !(t.role === "user" && KEYWORD.test(t.text))).slice(-max);

  /** gemma4 drafts an idea from the conversation; sentences not grounded in what was said are dropped. */
  async function draftIdea(sessionId: string): Promise<IdeaDraft | null> {
    const turns = transcriptOf(sessionId); if (!turns.some(t => t.role === "user" || t.role === "note")) return null;
    const src = turns.map(t => `${speaker(t)}: ${t.text}`).join("\n");
    const raw = await d.llm([{ role: "system", content: "Extract ONE new idea Richard is proposing in this conversation. Reply with JSON only: {\"title\": \"<at most 10 words>\", \"description\": \"<2 to 4 sentences>\"}. " +
      "Use only what was said in the conversation; do not add features, numbers or claims that were not mentioned." }, { role: "user", content: src }], { numPredict: 250, temperature: 0.2 });
    const j = parseJsonObject(raw); const title = String(j?.title ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "").slice(0, 120);
    const g = groundSummary(String(j?.description ?? "").replace(/\s+/g, " ").trim(), src, 0.5);
    if (g.dropped.length) log("idea draft dropped ungrounded", JSON.stringify(g.dropped));
    if (!title || !g.text) return null;
    return { title, content: g.text };
  }

  /** Extracts the topic; uses the active idea when the topic fits it (embedding similarity), else a topic skill. */
  async function proposeSkill(sessionId: string): Promise<SkillProposal | null> {
    const s = store.getSession(sessionId); if (!s) return null;
    const turns = transcriptOf(sessionId);
    const ideaRow = s.idea_id ? d.db.prepare(`SELECT id, title, content FROM ideas WHERE id = ?`).get(s.idea_id) as { id: string; title: string; content: string } : undefined;
    if (!turns.some(t => t.role === "user" || t.role === "note")) {
      return ideaRow ? { mode: "idea", topic: ideaRow.title, seed: ideaRow.content, ideaId: ideaRow.id, ideaTitle: ideaRow.title, fit: 1 } : null;
    }
    const src = turns.map(t => `${speaker(t)}: ${t.text}`).join("\n");
    const raw = await d.llm([{ role: "system", content: "What topic should a deep-dive research write-up cover, based on this conversation? Reply with JSON only: {\"topic\": \"<3 to 8 word topic title>\", \"seed\": \"<2 to 3 sentences describing what to research, using only what was said>\"}." },
      { role: "user", content: (ideaRow ? `ACTIVE IDEA: ${ideaRow.title}\n` : "") + src }], { numPredict: 200, temperature: 0.2 });
    const j = parseJsonObject(raw); const topic = String(j?.topic ?? "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "").slice(0, 120);
    const seed = groundSummary(String(j?.seed ?? "").replace(/\s+/g, " ").trim(), (ideaRow ? `${ideaRow.title} ${ideaRow.content} ` : "") + src, 0.5).text || topic;
    if (!topic) return null;
    let fit: number | null = null;
    if (ideaRow) {
      const iv = loadIdeaVectors(d.db).get(ideaRow.id); const [tv] = await d.embed([`${topic}\n${seed}`]);
      fit = iv ? Number(cosine(tv!, iv).toFixed(3)) : null;
    }
    const useIdea = !!ideaRow && fit !== null && fit >= SKILL_FIT;
    return { mode: useIdea ? "idea" : "topic", topic, seed, ideaId: useIdea ? ideaRow!.id : null, ideaTitle: useIdea ? ideaRow!.title : null, fit };
  }

  /** Confirmed idea draft -> existing POST /ideas logic; links the session (and attaches it if it had no idea). */
  async function confirmIdea(sessionId: string, draft: IdeaDraft) {
    const r = await d.createIdea(draft.title.slice(0, 200), draft.content.slice(0, 10000));
    store.link(sessionId, "created_idea", r.id);
    return r;
  }
  async function confirmSkill(sessionId: string, p: SkillProposal) {
    const r = p.mode === "idea" && p.ideaId ? await d.createSkill(p.ideaId) : await d.createTopicSkill(p.topic, p.seed, sessionId);
    const skillId = r.body?.skillId as string | undefined;
    if (r.status === 202 && skillId) store.link(sessionId, p.mode === "idea" ? "queued_skill" : "created_topic_skill", skillId);
    return r;
  }
  const skillReply = (r: { status: number; body: any }, p: SkillProposal) => r.status === 202 ? `Okay, I queued a deep dive on ${p.mode === "idea" ? p.ideaTitle : p.topic}. It takes about five minutes.`
    : r.status === 409 ? (r.body?.activeJobId ? "A deep dive on that is already running." : "That's already a skill. You can refresh it from the dashboard.") : "Sorry, I couldn't queue the deep dive.";

  /** Web chat turn. Keyword actions return a draft for the UI to confirm; nothing is created here. */
  async function webMessage(sessionId: string, text: string): Promise<{ reply: string; action?: { type: "idea_draft"; draft: IdeaDraft } | { type: "skill_draft"; proposal: SkillProposal }; used?: string[]; timings: Record<string, number> }> {
    const t0 = now(); const timings: Record<string, number> = {};
    const s = store.getSession(sessionId)!; const intent = parseIntent(text);
    store.addTurn(sessionId, "user", text, "web");
    const done = (reply: string, extra: object = {}) => { store.addTurn(sessionId, "assistant", reply, "web"); timings.total = now() - t0; return { reply, timings, ...extra }; };
    if (intent.kind === "make_idea") {
      const dft = await draftIdea(sessionId);
      return dft ? done(`Here's a draft idea. Edit it if you like, then confirm.\n\n${dft.title}\n${dft.content}`, { action: { type: "idea_draft", draft: dft } })
        : done("There isn't enough in this conversation yet to turn into an idea.");
    }
    if (intent.kind === "skill") {
      const p = await proposeSkill(sessionId);
      return p ? done(p.mode === "idea" ? `I can start a deep dive on this idea: ${p.ideaTitle}. Confirm to queue it.` : `I can start a deep dive on the topic "${p.topic}". Confirm to queue it.`, { action: { type: "skill_draft", proposal: p } })
        : done("There isn't enough in this conversation yet to pick a topic.");
    }
    if (s.idea_id) {
      const t1 = now(); const ctx = await loadContext(s.idea_id, text, 6); timings.context = now() - t1;
      const p = buildContext(ctx, text, "web"); const t2 = now();
      const raw = await d.llm([{ role: "system", content: p.system }, { role: "user", content: p.user }], { numPredict: 450, temperature: 0.3 });
      timings.llm = now() - t2;
      const g = finishGrounded(stripReasoning(raw) || raw, ctx.facts, { cap: false });
      return done(g.text.slice(0, 2500) || "Sorry, I don't have an answer for that.", { used: g.used });
    }
    const hist = store.turns(sessionId).slice(-12, -1).filter(t => t.role !== "note").map(t => ({ role: t.role as "user" | "assistant", content: t.text }));
    const t2 = now();
    const raw = await d.llm([{ role: "system", content: "You are Bailey, Richard's local assistant, in a text chat. Answer helpfully in plain text, at most three short paragraphs, no markdown. If you don't know, say so." }, ...hist, { role: "user", content: text }], { numPredict: 450, temperature: 0.4 });
    timings.llm = now() - t2;
    return done((stripReasoning(raw) || raw).replace(/[*#`]+/g, "").trim().slice(0, 2500));
  }
  function closeSession(sessionId: string, reason = "user") { const s = store.getSession(sessionId); if (s && !s.ended_at) { endSession(s, reason); return true; } return false; }

  async function activate(deviceId: string, sess: Session | undefined, ideaId: string): Promise<Session> {
    // A session about another idea, or an idea-less one that already has turns (general Q&A), is closed; the idea gets a fresh session.
    if (sess && (sess.idea_id ? sess.idea_id !== ideaId : store.turns(sess.id).length > 0)) { endSession(sess, "switch"); sess = undefined; }
    if (!sess) sess = store.startSession({ channel: "voice", deviceId, ideaId });
    else { store.setIdea(sess.id, ideaId); store.setState(sess.id, null); }
    return store.getSession(sess.id)!;
  }

  async function handle(deviceId: string, text: string): Promise<Reply> {
    const t0 = now(); const timings: Record<string, number> = {};
    let sess = store.activeForDevice(deviceId);
    if (sess && now() - sess.last_activity_at > idleMs) { endSession(sess, "timeout"); sess = undefined; }
    let intent = parseIntent(text);
    const pending: Pending | null = sess?.state ? JSON.parse(sess.state).pending ?? null : null;
    // Navigation turns (open/confirm/recap/close) are not stored: history keeps only the substance of the conversation.
    const NAV = new Set(["open", "confirm", "choose", "recap", "close"]);
    const record = (s: Session | undefined, r: Reply, userText = text): Reply => {
      if (s && !NAV.has(r.intent)) { store.addTurn(s.id, "user", userText, "voice"); store.addTurn(s.id, "assistant", r.reply, "voice"); }
      timings.total = now() - t0; return { ...r, sessionId: s?.id, ideaId: s ? store.getSession(s.id)?.idea_id ?? null : null, timings };
    };

    if (intent.kind === "capture") {
      try { const r = await d.captureIdea(intent.content); return record(sess, { reply: `Got it. I saved your idea: ${r.title}.`, emotion: "happy", intent: "capture" }); }
      catch (e) { log("capture failed", e); return record(sess, { reply: "Sorry, I couldn't save that idea.", emotion: "sad", intent: "capture" }); }
    }

    if (pending && sess && (pending.kind === "save_idea" || pending.kind === "save_skill")) {
      if (intent.kind === "yes") {
        store.setState(sess.id, null);
        if (pending.kind === "save_idea") {
          try { const r = await confirmIdea(sess.id, pending.draft); return record(sess, { reply: capReply(`Saved. ${r.title} is in your idea queue.`), emotion: "happy", intent: "make_idea" }); }
          catch (e) { log("make idea failed", e); return record(sess, { reply: "Sorry, I couldn't save that idea.", emotion: "sad", intent: "make_idea" }); }
        }
        const r = await confirmSkill(sess.id, pending.proposal).catch(e => ({ status: 0, body: { error: String(e) } }));
        return record(sess, { reply: capReply(skillReply(r, pending.proposal)), emotion: r.status === 202 ? "happy" : "neutral", intent: "skill" });
      }
      if (intent.kind === "no") { store.setState(sess.id, null); return record(sess, { reply: "Okay, I won't save it.", emotion: "neutral", intent: pending.kind === "save_idea" ? "make_idea" : "skill" }); }
      store.setState(sess.id, null); // anything else cancels the question
    } else if (pending && sess && (pending.kind === "confirm" || pending.kind === "choose")) {
      let chosen: { id: string; title: string } | undefined;
      if (intent.kind === "yes" && pending.kind === "confirm") chosen = pending.candidates[0];
      else if (intent.kind === "pick") chosen = pending.candidates[intent.index];
      else if (intent.kind === "yes" && pending.kind === "choose") return record(sess, { reply: `Which one: ${pending.candidates.map(c => c.title).join(", or ")}?`, emotion: "neutral", intent: "choose" });
      else if (intent.kind === "no") {
        const rest = pending.kind === "confirm" ? pending.candidates.slice(1) : [];
        if (rest.length) { store.setState(sess.id, { pending: { kind: "confirm", candidates: rest } }); return record(sess, { reply: capReply(`Or did you mean ${rest[0]!.title}?`), emotion: "neutral", intent: "confirm" }); }
        store.setState(sess.id, null); return record(sess, { reply: "Okay. Which idea do you want to talk about?", emotion: "neutral", intent: "confirm" });
      }
      if (chosen) {
        const s2 = await activate(deviceId, sess, chosen.id); const t1 = now();
        const r = await recap(chosen.id); timings.recap = now() - t1;
        return record(s2, { reply: r, emotion: "happy", intent: "recap" });
      }
      store.setState(sess.id, null); // anything else cancels the pending question and is handled normally
    }

    let opened: Awaited<ReturnType<typeof match>> | null = null;
    if (intent.kind === "open") {
      const t1 = now(); const m = opened = await match(intent.query); timings.match = now() - t1;
      log("match", JSON.stringify({ q: intent.query, kind: m.kind, top: m.ranked.slice(0, 3).map(r => [r.title, r.score]) }));
      if (m.kind === "none" && intent.strong) return record(sess, { reply: "I couldn't find an idea like that. Try saying part of its title.", emotion: "neutral", intent: "open" });
      if (m.kind === "none") intent = { kind: "question", text: clean(text) }; // bare "open X" with no match: a question
    }
    if (intent.kind === "open") {
      const m = opened!;
      const pend: Pending = m.kind === "confident" ? { kind: "confirm", candidates: m.top } : { kind: "choose", candidates: m.top };
      if (!sess) sess = store.startSession({ channel: "voice", deviceId, state: { pending: pend } }); else store.setState(sess.id, { pending: pend });
      const reply = m.kind === "confident" ? capReply(`${m.top[0]!.title}?`) : m.top.length > 1 ? capReply(`Did you mean ${m.top[0]!.title}, or ${m.top[1]!.title}?`) : capReply(`Did you mean ${m.top[0]!.title}?`);
      if (m.kind === "ambiguous" && m.top.length === 1) store.setState(sess.id, { pending: { kind: "confirm", candidates: m.top } });
      return record(sess, { reply, emotion: "neutral", intent: "open" });
    }

    const active = sess?.idea_id ? sess : undefined;
    if (intent.kind === "close") {
      if (!sess) return { reply: "Okay.", emotion: "neutral", intent: "close", timings };
      const title = sess.idea_id ? ideaTitle(sess.idea_id) : null;
      const r = record(sess, { reply: title ? capReply(`Okay, closing ${title}. I'll remember where we left off.`) : "Okay.", emotion: "neutral", intent: "close" });
      endSession(store.getSession(sess.id)!, "user"); return r;
    }
    if (intent.kind === "make_idea" || intent.kind === "skill") {
      if (!sess) return { reply: "There's nothing to save yet. Tell me about it first.", emotion: "neutral", intent: intent.kind, timings };
      store.addTurn(sess.id, "user", text, "voice");
      if (intent.kind === "make_idea") {
        const dft = await draftIdea(sess.id);
        if (!dft) { const reply = "There isn't enough in our conversation yet to make an idea."; store.addTurn(sess.id, "assistant", reply, "voice"); return { reply, emotion: "neutral", intent: "make_idea", sessionId: sess.id, timings }; }
        store.setState(sess.id, { pending: { kind: "save_idea", draft: dft } });
        const reply = capReply(`The idea is: ${dft.title}. Save it?`); store.addTurn(sess.id, "assistant", reply, "voice");
        timings.total = now() - t0; return { reply, emotion: "neutral", intent: "make_idea", sessionId: sess.id, ideaId: sess.idea_id, timings };
      }
      const p = await proposeSkill(sess.id);
      if (!p) { const reply = "There isn't enough in our conversation yet to pick a topic."; store.addTurn(sess.id, "assistant", reply, "voice"); return { reply, emotion: "neutral", intent: "skill", sessionId: sess.id, timings }; }
      store.setState(sess.id, { pending: { kind: "save_skill", proposal: p } });
      const reply = capReply(p.mode === "idea" ? `Start a deep dive on ${p.ideaTitle}?` : `Start a deep dive on the topic ${p.topic}?`); store.addTurn(sess.id, "assistant", reply, "voice");
      timings.total = now() - t0; return { reply, emotion: "neutral", intent: "skill", sessionId: sess.id, ideaId: sess.idea_id, timings };
    }
    if (!active) {
      if (intent.kind === "note" || intent.kind === "evaluation")
        return { reply: "Open an idea first. For example, say: let's talk about the habit tracker.", emotion: "neutral", intent: intent.kind, timings };
      const t1 = now(); const reply = await d.generalAnswer(text); timings.llm = now() - t1;
      // General questions are kept in an idea-less voice session so "make this an idea" can use them.
      if (!sess) sess = store.startSession({ channel: "voice", deviceId });
      return record(sess, { reply, emotion: "neutral", intent: "general" });
    }
    const ideaId = active.idea_id!;
    if (intent.kind === "note") {
      store.addTurn(active.id, "note", intent.text, "voice");
      timings.total = now() - t0; return { reply: "Noted.", emotion: "happy", intent: "note", sessionId: active.id, ideaId, timings };
    }
    if (intent.kind === "evaluation") {
      const e = d.db.prepare(`SELECT feasibility, cost, relevance, novelty, summary FROM idea_evaluations WHERE idea_id = ?`).get(ideaId) as IdeaContext["evaluation"];
      const reply = e ? capReply(`Feasibility ${e.feasibility}, cost ${e.cost}, relevance ${e.relevance}, novelty ${e.novelty}, out of five. ${(e.summary.match(/[^.!?]+[.!?]/) ?? [""])[0]}`)
        : "It hasn't been evaluated yet.";
      return record(active, { reply, emotion: "neutral", intent: "evaluation" });
    }
    if (intent.kind === "yes" || intent.kind === "no" || intent.kind === "pick") return record(active, { reply: "Okay.", emotion: "neutral", intent: intent.kind });
    // grounded question
    const q = intent.kind === "question" ? intent.text : text;
    const t1 = now(); const ctx = await loadContext(ideaId, q); timings.context = now() - t1;
    const p = buildContext(ctx, q); const t2 = now();
    const raw = await d.llm([{ role: "system", content: p.system }, { role: "user", content: p.user }], { numPredict: 150, temperature: 0.3 });
    timings.llm = now() - t2;
    const g = finishGrounded(raw, ctx.facts);
    log("grounded", JSON.stringify({ facts: ctx.facts.map(f => [f.tag, f.source, f.sim.toFixed(3)]), used: g.used }));
    return record(active, { reply: g.text || "Sorry, I don't have a short answer for that.", emotion: "neutral", intent: "grounded" });
  }

  return { handle, sweepIdle, summarize, recap, match, loadContext, store, draftIdea, proposeSkill, confirmIdea, confirmSkill, webMessage, closeSession, flush: () => Promise.all([...pendingSummaries]) };
}
export type Explorer = ReturnType<typeof createExplorer>;
