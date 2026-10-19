
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

mkdirSync("./data", { recursive: true });

const db = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    parent_id TEXT REFERENCES ideas(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'user',
    depth INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_memories_category
    ON memories(category);

  CREATE INDEX IF NOT EXISTS idx_ideas_parent
    ON ideas(parent_id);
`);

export interface Memory {
  id: string;
  category: string;
  content: string;
  source: string;
  created_at: string;
}

export function saveMemory(
  category: string,
  content: string
): Memory {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO memories (id, category, content)
    VALUES (?, ?, ?)
  `).run(id, category, content);

  return db.prepare(`
    SELECT * FROM memories WHERE id = ?
  `).get(id) as Memory;
}

export function searchMemories(query: string): Memory[] {
  return db.prepare(`
    SELECT * FROM memories
    WHERE content LIKE ? OR category LIKE ?
    ORDER BY created_at DESC
    LIMIT 25
  `).all(`%${query}%`, `%${query}%`) as Memory[];
}

export function listMemories(): Memory[] {
  return db.prepare(`
    SELECT * FROM memories
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as Memory[];
}
