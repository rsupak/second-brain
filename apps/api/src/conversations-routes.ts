// Read-only conversation history routes (voice + web share one store per idea).
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createConversationStore, type Session } from "./conversations.js";

const IdParams = z.object({ id: z.string().min(1).max(100) });
const SessionParams = z.object({ sessionId: z.string().min(1).max(100) });
const Query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export async function conversationsRoutes(app: FastifyInstance, opts: { db: Database.Database }) {
  const db = opts.db; const store = createConversationStore(db);
  const ideaExists = db.prepare(`SELECT id, title FROM ideas WHERE id = ?`);
  const view = (s: Session) => ({ id: s.id, ideaId: s.idea_id, skillId: s.skill_id, channel: s.channel, deviceId: s.device_id,
    startedAt: s.started_at, lastActivityAt: s.last_activity_at, endedAt: s.ended_at, endReason: s.end_reason });
  const msgs = (id: string) => store.turns(id).map(t => ({ id: t.id, role: t.role, text: t.text, channel: t.channel, createdAt: t.created_at }));

  app.get("/ideas/:id/conversations", async (request, reply) => {
    const p = IdParams.safeParse(request.params); const q = Query.safeParse(request.query ?? {});
    if (!p.success || !q.success) return reply.code(400).send({ error: "Invalid request" });
    const idea = ideaExists.get(p.data.id) as { id: string; title: string } | undefined;
    if (!idea) return reply.code(404).send({ error: "Idea not found" });
    const sum = store.getSummary(idea.id);
    const sessions = store.ideaSessions(idea.id, q.data.limit).map(s => ({ ...view(s), messages: msgs(s.id) })).filter(s => s.messages.length > 0);
    return { idea, summary: sum ? { text: sum.summary, model: sum.model, updatedAt: sum.updated_at, lastSessionId: sum.last_session_id } : null, sessions };
  });

  app.get("/conversations/:sessionId", async (request, reply) => {
    const p = SessionParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid session id" });
    const s = store.getSession(p.data.sessionId);
    if (!s) return reply.code(404).send({ error: "Conversation not found" });
    return { session: view(s), messages: msgs(s.id) };
  });
}
