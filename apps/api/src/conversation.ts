import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database("./data/brain.sqlite");

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
      role IN ('user', 'assistant')
    ),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_session
    ON conversation_messages(session_id, created_at);
`);

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function getHistory(
  sessionId: string,
  limit = 20
): ChatMessage[] {
  const messages = db.prepare(`
    SELECT role, content
    FROM conversation_messages
    WHERE session_id = ?
    ORDER BY rowid DESC
    LIMIT ?
  `).all(sessionId, limit) as ChatMessage[];

  return messages.reverse();
}

export function saveMessage(
  sessionId: string,
  role: ChatMessage["role"],
  content: string
): void {
  db.prepare(`
    INSERT INTO conversation_messages
      (id, session_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(randomUUID(), sessionId, role, content);
}
