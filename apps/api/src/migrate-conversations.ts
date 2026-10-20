// Idempotent migration: shared conversation tables + idea embedding backfill. Never drops or rewrites existing rows.
// Usage: BRAIN_DB=/tmp/copy.sqlite npx tsx apps/api/src/migrate-conversations.ts [--no-embed]
import Database from "better-sqlite3";
import { ensureConversationTables, conversationCounts, ensureIdeaEmbeddings } from "./conversations.js";

const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000");
const before = conversationCounts(db);
ensureConversationTables(db);
let backfill: unknown = "skipped";
if (!process.argv.includes("--no-embed")) {
  const { embedTexts } = await import("./ai.js");
  backfill = await ensureIdeaEmbeddings(db, xs => embedTexts(xs));
}
console.log(JSON.stringify({ db: dbPath, before, after: conversationCounts(db), backfill }));
db.close();
