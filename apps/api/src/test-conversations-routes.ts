// Conversation routes + dashboard panel (app.inject on a BRAIN_DB copy). Seeds one voice and one web session.
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) { console.error("Refusing: set BRAIN_DB to a copy"); process.exit(2); }
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}`, ok ? "" : JSON.stringify(d ?? "")); };
const Database = (await import("better-sqlite3")).default;
const { createConversationStore } = await import("./conversations.js");
const db = new Database(dbPath); db.pragma("busy_timeout = 5000");
const store = createConversationStore(db);
const ideaId = db.prepare(`SELECT id FROM ideas WHERE title LIKE 'Habit tracker%'`).pluck().get() as string;
const legacy = db.prepare(`SELECT count(*) FROM conversation_messages`).pluck().get();
const v = store.startSession({ channel: "voice", ideaId, deviceId: "test" }); store.addTurn(v.id, "user", "How do I handle missed days?", "voice"); store.addTurn(v.id, "assistant", "Suggest one small next action.", "voice"); store.addTurn(v.id, "note", "try streak freeze", "voice"); store.endSession(v.id, "user");
const w = store.startSession({ channel: "web", ideaId }); store.addTurn(w.id, "user", "web question", "web");
store.putSummary(ideaId, "Richard discussed missed days.", "test-model", v.id);
const empty = store.startSession({ channel: "voice", deviceId: "test" }); // navigation-only session without idea: never listed
const { app } = await import("./server.js"); await app.ready();
const r = await app.inject({ method: "GET", url: `/ideas/${ideaId}/conversations` }); const b = r.json();
check("GET /ideas/:id/conversations 200 with summary + both channels", r.statusCode === 200 && b.summary?.text === "Richard discussed missed days." && b.sessions.length === 2 && new Set(b.sessions.map((s: any) => s.channel)).size === 2, b);
check("sessions newest first, messages oldest first incl. note role", b.sessions[0].id === w.id && b.sessions[1].messages.map((m: any) => m.role).join() === "user,assistant,note", b.sessions);
check("GET /ideas/:id/conversations 404 unknown idea", (await app.inject({ method: "GET", url: `/ideas/nope/conversations` })).statusCode === 404);
const s = await app.inject({ method: "GET", url: `/conversations/${v.id}` });
check("GET /conversations/:sessionId 200", s.statusCode === 200 && s.json().session.endReason === "user" && s.json().messages.length === 3, s.json());
check("GET /conversations/:sessionId 404", (await app.inject({ method: "GET", url: `/conversations/${empty.id}x` })).statusCode === 404);
check("conversation routes are read-only (POST 404)", (await app.inject({ method: "POST", url: `/conversations/${v.id}`, payload: {} })).statusCode === 404);
check("existing /health and /ideas unchanged", (await app.inject({ method: "GET", url: "/health" })).json().status === "ok" && Array.isArray((await app.inject({ method: "GET", url: "/ideas" })).json()));
const js = (await app.inject({ method: "GET", url: "/dashboard/app.js" })).body; const css = (await app.inject({ method: "GET", url: "/dashboard/styles.css" })).body;
check("dashboard: conversationsPanel on idea page, channel badge, summary", js.includes("function conversationsPanel(") && js.includes("conversationsPanel(id)") && js.includes("/conversations`") && js.includes('class: `channel ${m.channel}`') && css.includes(".channel.voice"));
check("dashboard: still no innerHTML/eval", !/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(js));
check("legacy conversation_messages untouched", db.prepare(`SELECT count(*) FROM conversation_messages`).pluck().get() === legacy);
await app.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
