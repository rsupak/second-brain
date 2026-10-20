// Web chat routes, keyword actions, topic skills (queueing only; no deep dive is run). app.inject on a BRAIN_DB copy, real gemma4.
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) { console.error("Refusing: set BRAIN_DB to a copy"); process.exit(2); }
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d?: unknown) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}`, d === undefined ? "" : typeof d === "string" ? d : JSON.stringify(d)); };
const Database = (await import("better-sqlite3")).default;
const db = new Database(dbPath); db.pragma("busy_timeout = 5000");
const n = (sql: string, ...a: unknown[]) => db.prepare(sql).pluck().get(...a) as number;
const legacy = n(`SELECT count(*) FROM conversation_messages`), ideas0 = n(`SELECT count(*) FROM ideas`);
const { app } = await import("./server.js"); await app.ready();
const J = { "content-type": "application/json" };
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { ...J, ...headers } });
const get = (url: string) => app.inject({ method: "GET", url });
const habit = db.prepare(`SELECT id FROM ideas WHERE title LIKE 'Habit tracker%'`).pluck().get() as string;
const transcript: string[] = [];
const say = async (sid: string, text: string) => {
  const t0 = Date.now(); const r = await post(`/chat/sessions/${sid}/messages`, { text }); const b = r.json(); const ms = Date.now() - t0;
  const a = (b.messages ?? []).find((m: any) => m.role === "assistant");
  transcript.push(`You: ${text}`, `Bailey: ${a?.text}` + (b.action ? `\n  [action ${b.action.type}] ${JSON.stringify(b.action.draft ?? b.action.proposal)}` : ""));
  console.log(`   (${ms} ms, status ${r.statusCode}, used=${JSON.stringify(b.used)})`);
  return { r, b, a, ms };
};

// guard
check("cross-site Origin refused (403)", (await post("/chat/sessions", { ideaId: habit }, { origin: "http://evil.example" })).statusCode === 403);
check("Sec-Fetch-Site cross-site refused (403)", (await post("/chat/sessions", {}, { "sec-fetch-site": "cross-site" })).statusCode === 403);
check("non-JSON body refused (415)", (await app.inject({ method: "POST", url: "/chat/sessions", payload: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).statusCode === 415);
check("same-origin dashboard request allowed", (await post("/chat/sessions", {}, { origin: "http://127.0.0.1:3333", "sec-fetch-site": "same-origin" })).statusCode === 201);
check("unknown idea 404", (await post("/chat/sessions", { ideaId: "nope" })).statusCode === 404);

// per-idea web chat
const c = await post("/chat/sessions", { ideaId: habit }); const sid = c.json().session.id;
check("POST /chat/sessions (idea) 201 channel web", c.statusCode === 201 && c.json().session.channel === "web" && c.json().session.ideaId === habit);
const m1 = await say(sid, "Could the habit tracker send a weekly email digest of my streaks?");
check("grounded web reply: plain text, longer allowed, no [F#] tags", m1.r.statusCode === 200 && !!m1.a && m1.a.text.length > 20 && !/\[F\d|\*\*|<\/?\w+>/.test(m1.a.text), `${m1.a?.text.length} chars`);
const m2 = await say(sid, "Make this an idea.");
const draft = m2.b.action?.draft;
check("'make this an idea' -> idea_draft (title + description), nothing created yet", m2.b.action?.type === "idea_draft" && !!draft?.title && !!draft?.content && n(`SELECT count(*) FROM ideas`) === ideas0, draft);
const ci = await post("/ideas", { title: draft.title, content: draft.content }, { origin: "http://127.0.0.1:3333" });
check("confirm: existing POST /ideas 201 + auto-queued jobs", ci.statusCode === 201 && !!ci.json().jobId && "evaluationJobId" in ci.json() && "researchJobId" in ci.json(), Object.keys(ci.json()));
const newIdea = ci.json().idea.id;
const lk = await post(`/chat/sessions/${sid}/links`, { kind: "created_idea", targetId: newIdea });
check("session linked to the new idea (keeps its own idea)", lk.statusCode === 200 && lk.json().links.some((l: any) => l.kind === "created_idea" && l.target_id === newIdea) && lk.json().session.ideaId === habit);
const m3 = await say(sid, "Add this as a skill.");
const prop = m3.b.action?.proposal;
check("'add this as a skill' -> skill_draft, nothing queued yet", m3.b.action?.type === "skill_draft" && !!prop?.topic && n(`SELECT count(*) FROM jobs WHERE type='deep_dive' AND status='pending'`) === 0, prop);
if (prop?.mode === "idea") {
  const q = await post(`/ideas/${prop.ideaId}/skill`, {});
  check("confirm (fits idea): existing POST /ideas/:id/skill queues a deep dive", q.statusCode === 202 && n(`SELECT count(*) FROM jobs WHERE type='deep_dive' AND status='pending' AND json_extract(payload,'$.ideaId') = ?`, habit) === 1, q.json());
} else check("confirm path: proposal fit for the habit chat was expected to use the idea", false, prop);

// general chat -> topic skill
const g = await post("/chat/sessions", {}); const gid = g.json().session.id;
check("general chat 201 with no idea", g.statusCode === 201 && g.json().session.ideaId === null);
await say(gid, "What is the Zettelkasten note-taking method and how do people link notes?");
const t1 = await say(gid, "Add this as a skill.");
const tp = t1.b.action?.proposal;
check("general chat skill_draft is a TOPIC skill", tp?.mode === "topic" && tp.ideaId === null && !!tp.seed, tp);
const ts = await post("/skills/topic", { topic: tp.topic, seed: tp.seed, sessionId: gid });
const tsb = ts.json();
check("POST /skills/topic 202, queued deep_dive job", ts.statusCode === 202 && !!tsb.skillId && !!tsb.jobId, tsb);
const anchor = db.prepare(`SELECT i.* FROM topic_skills t JOIN ideas i ON i.id = t.anchor_idea_id WHERE t.skill_id = ?`).get(tsb.skillId) as any;
const payload = JSON.parse(n(`SELECT payload FROM jobs WHERE id = ?`, tsb.jobId) as unknown as string);
check("topic skill: anchor idea origin=topic, content = seed; job payload points at anchor (worker reads title/content from it)", anchor?.origin === "topic" && anchor.content === tp.seed && payload.ideaId === anchor.id && payload.skillId === tsb.skillId, { anchor: anchor?.title, payload });
check("deep-dive worker query returns the topic seed text", (db.prepare(`SELECT content FROM ideas WHERE id = ?`).pluck().get(payload.ideaId) as string) === tp.seed);
check("session linked to topic skill", (await get(`/chat/sessions/${gid}`)).json().links.some((l: any) => l.kind === "created_topic_skill" && l.target_id === tsb.skillId));
check("duplicate topic skill -> 409", (await post("/skills/topic", { topic: tp.topic, seed: "x y z" })).statusCode === 409);
check("GET /skills lists the topic skill", (await get("/skills")).json().some((s: any) => s.id === tsb.skillId));
await post("/evaluations/queue", {});
check("evaluation queue skips topic anchors", n(`SELECT count(*) FROM evaluation_jobs WHERE idea_id = ?`, anchor.id) === 0);
check("GET /ideas shape unchanged (array of ideas)", Array.isArray((await get("/ideas")).json()));

// attach general chat later
const at = await post(`/chat/sessions/${gid}/attach`, { ideaId: habit });
check("attach general chat to an idea", at.statusCode === 200 && at.json().session.ideaId === habit);
check("attach to a different idea -> 409", (await post(`/chat/sessions/${gid}/attach`, { ideaId: newIdea })).statusCode === 409);

// listing / reading
check("GET /chat/sessions?ideaId lists both web chats", (await get(`/chat/sessions?ideaId=${habit}`)).json().sessions.length === 2);
check("GET /chat/sessions/:id returns messages", (await get(`/chat/sessions/${sid}`)).json().messages.length === 6);
check("GET /ideas/:id/conversations shows web chats", (await get(`/ideas/${habit}/conversations`)).json().sessions.filter((s: any) => s.channel === "web").length === 2);

// close -> summary; post after close continues in a new session
const cl = await post(`/chat/sessions/${sid}/close`, {});
let summary: string | undefined; const t0 = Date.now();
while (Date.now() - t0 < 90_000) { summary = db.prepare(`SELECT summary FROM idea_conversation_summaries WHERE idea_id = ?`).pluck().get(habit) as string | undefined; if (summary) break; await new Promise(r => setTimeout(r, 1000)); }
check("close -> summary written for the idea", cl.json().closed === true && !!summary, `${Date.now() - t0} ms: ${summary}`);
const after = await post(`/chat/sessions/${sid}/messages`, { text: "One more thing: should the digest be opt-in?" });
check("message to a closed chat continues in a new web session", after.statusCode === 200 && after.json().continuedFrom === sid && after.json().sessionId !== sid);
check("existing POST /chat route still registered", app.hasRoute({ method: "POST", url: "/chat" }));
check("legacy conversation_messages untouched", n(`SELECT count(*) FROM conversation_messages`) === legacy);
await app.close();
console.log("WEB TRANSCRIPT\n  " + transcript.join("\n  "));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
