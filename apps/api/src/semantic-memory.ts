import Database from "better-sqlite3";
import { embed, cosineSimilarity } from "./embeddings.js";
import type { Memory } from "./database.js";

const db = new Database("./data/brain.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY
      REFERENCES memories(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    vector TEXT NOT NULL
  );
`);

const MODEL = "qwen3-embedding:0.6b";

export async function indexMemory(memory: Memory) {
  const vector = await embed(
    `${memory.category}: ${memory.content}`
  );

  db.prepare(`
    INSERT INTO memory_embeddings (memory_id, model, vector)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      model = excluded.model,
      vector = excluded.vector
  `).run(memory.id, MODEL, JSON.stringify(vector));
}

export async function reindexMemories() {
  const memories = db.prepare(`
    SELECT m.*
    FROM memories m
    LEFT JOIN memory_embeddings e
      ON e.memory_id = m.id AND e.model = ?
    WHERE e.memory_id IS NULL
  `).all(MODEL) as Memory[];

  let indexed = 0;

  for (const memory of memories) {
    await indexMemory(memory);
    indexed++;
  }

  return { indexed };
}

export async function semanticSearch(
  query: string,
  limit = 5
) {
  const queryVector = await embed(query);

  const rows = db.prepare(`
    SELECT m.*, e.vector
    FROM memories m
    JOIN memory_embeddings e ON e.memory_id = m.id
    WHERE e.model = ?
  `).all(MODEL) as (Memory & { vector: string })[];

  return rows
    .map(({ vector, ...memory }) => ({
      ...memory,
      score: cosineSimilarity(
        queryVector,
        JSON.parse(vector) as number[]
      )
    }))
    .filter(item => item.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
