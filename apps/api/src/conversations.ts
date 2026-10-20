// Shared conversation store for voice (AIPI) and the upcoming web chat.
// Additive, idempotent: new tables only. The legacy conversation_messages table (POST /chat) is left untouched.
import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { toBlob, fromBlob } from "./research.js";

export type Channel = "voice" | "web";
export type Role = "user" | "assistant" | "note";
export const EMBED_MODEL = "qwen3-embedding:0.6b";
export const IDLE_MS = Number(process.env.CONVERSATION_IDLE_MS ?? 10 * 60 * 1000);

export function ensureConversationTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id TEXT PRIMARY KEY,
      idea_id TEXT REFERENCES ideas(id),
      skill_id TEXT REFERENCES skills(id),
      channel TEXT NOT NULL CHECK (channel IN ('voice','web')),
      device_id TEXT,
      state TEXT,                       -- JSON: pending confirmation / candidates (voice)
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_sessions_idea ON conversation_sessions(idea_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_conv_sessions_device ON conversation_sessions(device_id, ended_at);
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES conversation_sessions(id),
      role TEXT NOT NULL CHECK (role IN ('user','assistant','note')),
      text TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('voice','web')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_id, created_at);
    -- What a conversation produced or was attached to: created_idea, queued_skill, created_topic_skill, attached_idea.
    CREATE TABLE IF NOT EXISTS conversation_links (
      session_id TEXT NOT NULL REFERENCES conversation_sessions(id),
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, kind, target_id)
    );
    CREATE TABLE IF NOT EXISTS idea_conversation_summaries (
      idea_id TEXT PRIMARY KEY REFERENCES ideas(id),
      summary TEXT NOT NULL,
      model TEXT NOT NULL,
      last_session_id TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function conversationCounts(db: Database.Database) {
  const n = (t: string) => { try { return db.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number; } catch { return null; } };
  return { conversation_messages: n("conversation_messages"), conversation_sessions: n("conversation_sessions"), conversation_turns: n("conversation_turns"), conversation_links: n("conversation_links"),
    idea_conversation_summaries: n("idea_conversation_summaries"), ideas: n("ideas"), idea_embeddings: n("idea_embeddings") };
}

export type Session = { id: string; idea_id: string | null; skill_id: string | null; channel: Channel; device_id: string | null; state: string | null;
  started_at: number; last_activity_at: number; ended_at: number | null; end_reason: string | null };
export type Turn = { id: string; session_id: string; role: Role; text: string; channel: Channel; created_at: number };

export function createConversationStore(db: Database.Database, now = () => Date.now()) {
  ensureConversationTables(db);
  const q = {
    insSession: db.prepare(`INSERT INTO conversation_sessions (id, idea_id, skill_id, channel, device_id, state, started_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?)`),
    getSession: db.prepare(`SELECT * FROM conversation_sessions WHERE id = ?`),
    activeForDevice: db.prepare(`SELECT * FROM conversation_sessions WHERE device_id = ? AND channel = 'voice' AND ended_at IS NULL ORDER BY last_activity_at DESC LIMIT 1`),
    touch: db.prepare(`UPDATE conversation_sessions SET last_activity_at = ? WHERE id = ?`),
    setState: db.prepare(`UPDATE conversation_sessions SET state = ?, last_activity_at = ? WHERE id = ?`),
    setIdea: db.prepare(`UPDATE conversation_sessions SET idea_id = ?, skill_id = ?, last_activity_at = ? WHERE id = ?`),
    end: db.prepare(`UPDATE conversation_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL`),
    idle: db.prepare(`SELECT * FROM conversation_sessions WHERE ended_at IS NULL AND last_activity_at < ?`),
    insTurn: db.prepare(`INSERT INTO conversation_turns (id, session_id, role, text, channel, created_at) VALUES (?,?,?,?,?,?)`),
    turns: db.prepare(`SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY created_at, rowid`),
    ideaSessions: db.prepare(`SELECT * FROM conversation_sessions WHERE idea_id = ? ORDER BY started_at DESC LIMIT ?`),
    recentForIdea: db.prepare(`SELECT t.* FROM conversation_turns t JOIN conversation_sessions s ON s.id = t.session_id
      WHERE s.idea_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`),
    summary: db.prepare(`SELECT * FROM idea_conversation_summaries WHERE idea_id = ?`),
    insLink: db.prepare(`INSERT OR IGNORE INTO conversation_links (session_id, kind, target_id, created_at) VALUES (?,?,?,?)`),
    links: db.prepare(`SELECT kind, target_id, created_at FROM conversation_links WHERE session_id = ? ORDER BY created_at`),
    attachIfNone: db.prepare(`UPDATE conversation_sessions SET idea_id = ? WHERE id = ? AND idea_id IS NULL`),
    webSessions: db.prepare(`SELECT * FROM conversation_sessions WHERE channel = 'web' AND (? IS NULL OR idea_id = ?) ORDER BY last_activity_at DESC LIMIT ?`),
    putSummary: db.prepare(`INSERT INTO idea_conversation_summaries (idea_id, summary, model, last_session_id, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(idea_id) DO UPDATE SET summary = excluded.summary, model = excluded.model, last_session_id = excluded.last_session_id, updated_at = excluded.updated_at`)
  };
  return {
    startSession(o: { channel: Channel; ideaId?: string | null; skillId?: string | null; deviceId?: string | null; state?: unknown }): Session {
      const id = randomUUID(), t = now();
      q.insSession.run(id, o.ideaId ?? null, o.skillId ?? null, o.channel, o.deviceId ?? null, o.state === undefined ? null : JSON.stringify(o.state), t, t);
      return q.getSession.get(id) as Session;
    },
    getSession: (id: string) => q.getSession.get(id) as Session | undefined,
    activeForDevice: (deviceId: string) => q.activeForDevice.get(deviceId) as Session | undefined,
    touch: (id: string) => q.touch.run(now(), id),
    setState: (id: string, state: unknown) => q.setState.run(state == null ? null : JSON.stringify(state), now(), id),
    setIdea: (id: string, ideaId: string | null, skillId: string | null = null) => q.setIdea.run(ideaId, skillId, now(), id),
    endSession: (id: string, reason: string) => q.end.run(now(), reason, id).changes > 0,
    idleSessions: (idleMs = IDLE_MS) => q.idle.all(now() - idleMs) as Session[],
    addTurn(sessionId: string, role: Role, text: string, channel: Channel): Turn {
      const t: Turn = { id: randomUUID(), session_id: sessionId, role, text, channel, created_at: now() };
      db.transaction(() => { q.insTurn.run(t.id, sessionId, role, text, channel, t.created_at); q.touch.run(t.created_at, sessionId); })();
      return t;
    },
    turns: (sessionId: string) => q.turns.all(sessionId) as Turn[],
    ideaSessions: (ideaId: string, limit = 50) => q.ideaSessions.all(ideaId, limit) as Session[],
    /** Last N turns for an idea across ALL channels and sessions, oldest first. */
    recentForIdea: (ideaId: string, limit = 8) => (q.recentForIdea.all(ideaId, limit) as Turn[]).reverse(),
    /** Records what the session produced; a created idea also becomes the session's idea if it had none. */
    link(sessionId: string, kind: string, targetId: string) {
      db.transaction(() => { q.insLink.run(sessionId, kind, targetId, now()); if (kind === "created_idea" || kind === "attached_idea") q.attachIfNone.run(targetId, sessionId); })();
    },
    links: (sessionId: string) => q.links.all(sessionId) as Array<{ kind: string; target_id: string; created_at: number }>,
    webSessions: (ideaId: string | null, limit = 50) => q.webSessions.all(ideaId, ideaId, limit) as Session[],
    getSummary: (ideaId: string) => q.summary.get(ideaId) as { idea_id: string; summary: string; model: string; last_session_id: string | null; updated_at: number } | undefined,
    putSummary: (ideaId: string, summary: string, model: string, sessionId: string | null) => q.putSummary.run(ideaId, summary, model, sessionId, now())
  };
}
export type ConversationStore = ReturnType<typeof createConversationStore>;

const hashText = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Same cache format as deep-dive findRelated(): sha256(title\ncontent). Embeds only missing/stale ideas. */
export async function ensureIdeaEmbeddings(db: Database.Database, embed: (xs: string[]) => Promise<number[][]>) {
  const ideas = db.prepare(`SELECT id, title, content FROM ideas`).all() as Array<{ id: string; title: string; content: string }>;
  const cached = new Map((db.prepare(`SELECT idea_id, content_hash FROM idea_embeddings WHERE model = ?`).all(EMBED_MODEL) as Array<{ idea_id: string; content_hash: string }>).map(r => [r.idea_id, r.content_hash]));
  const todo = ideas.filter(i => cached.get(i.id) !== hashText(`${i.title}\n${i.content}`));
  const save = db.prepare(`INSERT INTO idea_embeddings (idea_id, model, content_hash, vector) VALUES (?, ?, ?, ?)
    ON CONFLICT(idea_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash, vector = excluded.vector`);
  for (let i = 0; i < todo.length; i += 16) {
    const batch = todo.slice(i, i + 16);
    const vecs = await embed(batch.map(x => `${x.title}\n${x.content}`));
    db.transaction(() => batch.forEach((x, j) => save.run(x.id, EMBED_MODEL, hashText(`${x.title}\n${x.content}`), toBlob(vecs[j]!))))();
  }
  return { total: ideas.length, embedded: todo.length, ids: todo.map(t => t.id) };
}

export function loadIdeaVectors(db: Database.Database) {
  return new Map((db.prepare(`SELECT idea_id, vector FROM idea_embeddings WHERE model = ?`).all(EMBED_MODEL) as Array<{ idea_id: string; vector: Buffer }>)
    .map(r => [r.idea_id, fromBlob(r.vector)]));
}
