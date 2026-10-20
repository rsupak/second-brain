// Topic skills: deep dives that start from conversation text instead of one of Richard's ideas.
// Schema choice: skills.idea_id is NOT NULL + UNIQUE + FK(ideas), and research_sources.idea_id (written by every deep dive)
// is NOT NULL + FK(ideas) too. Making either nullable needs a table rebuild, which we never do. So a topic skill gets a
// hidden "anchor" row in ideas (origin = 'topic', title = topic, content = seed text) and a topic_skills mapping row.
// The deep-dive worker then runs unchanged from the anchor's title/content (= the topic seed text).
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createSkillStore, SkillExistsError } from "./skill-jobs.js";
import { ensureSkillTables } from "./skills-schema.js";

export const TOPIC_ORIGIN = "topic";
export function ensureTopicSkillTables(db: Database.Database) {
  ensureSkillTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_skills (
      skill_id TEXT PRIMARY KEY REFERENCES skills(id),
      anchor_idea_id TEXT NOT NULL UNIQUE REFERENCES ideas(id),
      topic TEXT NOT NULL,
      topic_key TEXT NOT NULL UNIQUE,
      seed_text TEXT NOT NULL,
      source_session_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}
const keyOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function createTopicSkillStore(db: Database.Database) {
  ensureTopicSkillTables(db);
  const skills = createSkillStore(db);
  const byKey = db.prepare(`SELECT skill_id FROM topic_skills WHERE topic_key = ?`).pluck();
  const insIdea = db.prepare(`INSERT INTO ideas (id, title, content, origin, depth) VALUES (?, ?, ?, '${TOPIC_ORIGIN}', 0)`);
  const insMap = db.prepare(`INSERT INTO topic_skills (skill_id, anchor_idea_id, topic, topic_key, seed_text, source_session_id, created_at) VALUES (?,?,?,?,?,?,?)`);
  const tx = db.transaction((topic: string, seed: string, sessionId: string | null) => {
    const k = keyOf(topic);
    const existing = byKey.get(k) as string | undefined;
    if (existing) throw new SkillExistsError(existing);
    const anchor = randomUUID();
    insIdea.run(anchor, topic, seed);
    const r = skills.create(anchor); // nested -> savepoint; queues the deep_dive job
    insMap.run(r.skillId, anchor, topic, k, seed, sessionId, Date.now());
    return { ...r, topic: true as const };
  });
  return {
    create: (topic: string, seed: string, sessionId: string | null = null) => tx.immediate(topic.trim(), seed.trim(), sessionId),
    isAnchor: (ideaId: string) => !!db.prepare(`SELECT 1 FROM topic_skills WHERE anchor_idea_id = ?`).get(ideaId)
  };
}
