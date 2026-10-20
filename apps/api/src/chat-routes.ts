// Web chat on the shared conversation store (channel 'web'), keyword actions, and topic skills.
// Every POST passes the root cross-site guard (security.ts). Existing POST /chat is untouched.
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createConversationStore, type Session } from "./conversations.js";
import { createExplorer } from "./voice/explore.js";
import { createSkillStore, ActiveDeepDiveError, SkillExistsError, NotFoundError } from "./skill-jobs.js";
import { createTopicSkillStore } from "./topic-skills.js";

export const CHAT_MODEL = process.env.CHAT_MODEL ?? process.env.VOICE_MODEL ?? "gemma4:e4b-it-qat";
const Id = z.string().min(1).max(100);
const LINK_KINDS = ["created_idea", "queued_skill", "created_topic_skill"] as const;

export async function chatRoutes(app: FastifyInstance, opts: { db: Database.Database; createIdea: (title: string, content: string) => Promise<{ id: string; title: string }> }) {
  const db = opts.db; const store = createConversationStore(db);
  const skills = createSkillStore(db); const topics = createTopicSkillStore(db);
  const skillResult = (fn: () => any) => {
    try { return { status: 202, body: { ...fn(), status: "pending" } }; }
    catch (e) {
      if (e instanceof NotFoundError) return { status: 404, body: { error: "Idea not found" } };
      if (e instanceof ActiveDeepDiveError) return { status: 409, body: { error: "A deep-dive job is already active for this skill", skillId: e.skillId, activeJobId: e.jobId } };
      if (e instanceof SkillExistsError) return { status: 409, body: { error: "A skill already exists for this topic", skillId: e.skillId } };
      throw e;
    }
  };
  const ex = createExplorer({
    db, model: CHAT_MODEL, log: (...a) => app.log.info(a.map(String).join(" ")),
    embed: async xs => (await import("./ai.js")).embedTexts(xs),
    llm: async (m, o) => (await import("./ai.js")).generateResponse(m, { model: CHAT_MODEL, think: false, temperature: o?.temperature ?? 0.3, numPredict: o?.numPredict ?? 450, numCtx: 4096, timeoutMs: 120_000 }),
    captureIdea: async c => opts.createIdea(c.split(/\s+/).slice(0, 10).join(" "), c),
    createIdea: opts.createIdea,
    createSkill: async id => skillResult(() => skills.create(id)),
    createTopicSkill: async (t, s, sid) => skillResult(() => topics.create(t, s, sid)),
    generalAnswer: async () => ""
  });
  const ideaExists = db.prepare(`SELECT id FROM ideas WHERE id = ?`).pluck();
  const skillExists = db.prepare(`SELECT id FROM skills WHERE id = ?`).pluck();
  const view = (s: Session) => ({ id: s.id, ideaId: s.idea_id, skillId: s.skill_id, channel: s.channel, startedAt: s.started_at, lastActivityAt: s.last_activity_at, endedAt: s.ended_at, endReason: s.end_reason });
  const msgs = (id: string) => store.turns(id).map(t => ({ id: t.id, role: t.role, text: t.text, channel: t.channel, createdAt: t.created_at }));
  const webSession = (id: string) => { const s = store.getSession(id); return s && s.channel === "web" ? s : undefined; };

  app.post("/chat/sessions", async (request, reply) => {
    const b = z.object({ ideaId: Id.nullish() }).safeParse(request.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "Invalid request" });
    if (b.data.ideaId && !ideaExists.get(b.data.ideaId)) return reply.code(404).send({ error: "Idea not found" });
    return reply.code(201).send({ session: view(store.startSession({ channel: "web", ideaId: b.data.ideaId ?? null })), messages: [] });
  });
  app.get("/chat/sessions", async (request, reply) => {
    const q = z.object({ ideaId: Id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(request.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "Invalid request" });
    return { sessions: store.webSessions(q.data.ideaId ?? null, q.data.limit).map(s => ({ ...view(s), messageCount: store.turns(s.id).length })) };
  });
  app.get("/chat/sessions/:id", async (request, reply) => {
    const p = z.object({ id: Id }).safeParse(request.params);
    const s = p.success ? webSession(p.data.id) : undefined;
    if (!s) return reply.code(404).send({ error: "Chat session not found" });
    return { session: view(s), messages: msgs(s.id), links: store.links(s.id) };
  });
  app.post("/chat/sessions/:id/messages", async (request, reply) => {
    const p = z.object({ id: Id }).safeParse(request.params); const b = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    let s = webSession(p.data.id); if (!s) return reply.code(404).send({ error: "Chat session not found" });
    let continuedFrom: string | undefined;
    if (s.ended_at) { continuedFrom = s.id; s = store.startSession({ channel: "web", ideaId: s.idea_id }); } // closed (or idle-timed-out): continue in a new session
    const before = store.turns(s.id).length;
    try {
      const r = await ex.webMessage(s.id, b.data.text);
      return { sessionId: s.id, ...(continuedFrom ? { continuedFrom } : {}), messages: msgs(s.id).slice(before), action: r.action ?? null, used: r.used ?? [], timings: r.timings };
    } catch (e) { request.log.error(e); return reply.code(503).send({ error: "AI response unavailable", sessionId: s.id }); }
  });
  app.post("/chat/sessions/:id/close", async (request, reply) => {
    const p = z.object({ id: Id }).safeParse(request.params); const s = p.success ? webSession(p.data.id) : undefined;
    if (!s) return reply.code(404).send({ error: "Chat session not found" });
    return { closed: ex.closeSession(s.id, "user"), summaryQueued: !!s.idea_id && !s.ended_at };
  });
  app.post("/chat/sessions/:id/attach", async (request, reply) => {
    const p = z.object({ id: Id }).safeParse(request.params); const b = z.object({ ideaId: Id }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const s = webSession(p.data.id); if (!s) return reply.code(404).send({ error: "Chat session not found" });
    if (!ideaExists.get(b.data.ideaId)) return reply.code(404).send({ error: "Idea not found" });
    if (s.idea_id && s.idea_id !== b.data.ideaId) return reply.code(409).send({ error: "Session is already attached to another idea", ideaId: s.idea_id });
    store.link(s.id, "attached_idea", b.data.ideaId);
    return { session: view(store.getSession(s.id)!) };
  });
  app.post("/chat/sessions/:id/links", async (request, reply) => {
    const p = z.object({ id: Id }).safeParse(request.params); const b = z.object({ kind: z.enum(LINK_KINDS), targetId: Id }).safeParse(request.body);
    if (!p.success || !b.success) return reply.code(400).send({ error: "Invalid request" });
    const s = webSession(p.data.id); if (!s) return reply.code(404).send({ error: "Chat session not found" });
    if (!(b.data.kind === "created_idea" ? ideaExists.get(b.data.targetId) : skillExists.get(b.data.targetId))) return reply.code(404).send({ error: "Target not found" });
    store.link(s.id, b.data.kind, b.data.targetId);
    return { session: view(store.getSession(s.id)!), links: store.links(s.id) };
  });
  app.post("/skills/topic", async (request, reply) => {
    const b = z.object({ topic: z.string().trim().min(3).max(120), seed: z.string().trim().min(3).max(4000), sessionId: Id.nullish() }).safeParse(request.body);
    if (!b.success) return reply.code(400).send({ error: "Invalid topic skill" });
    const r = skillResult(() => topics.create(b.data.topic, b.data.seed, b.data.sessionId ?? null));
    if (r.status === 202 && b.data.sessionId && store.getSession(b.data.sessionId)) store.link(b.data.sessionId, "created_topic_skill", r.body.skillId);
    return reply.code(r.status).send(r.body);
  });
}
