// Unit/integration tests for voice idea exploration. Runs on a COPY of the DB (BRAIN_DB required, refuses data/brain.sqlite).
// Uses the real embedding model and VOICE_MODEL (gemma4) for matching, grounded answers and summaries.
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { parseIntent, rankIdeas, decideMatch, buildContext, finishGrounded, groundSummary, createExplorer, type Fact } from "./voice/explore.js";
import { ensureConversationTables, conversationCounts } from "./conversations.js";

const dbPath = process.env.BRAIN_DB ?? "";
if (!dbPath || resolve(dbPath) === resolve("data/brain.sqlite")) { console.error("Set BRAIN_DB to a copy"); process.exit(2); }
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${extra ? "  " + extra : ""}`); };

// ---------- intent parsing ----------
const cases: Array<[string, string, any?]> = [
  ["Let's talk about the habit tracker.", "open", { query: "habit tracker" }],
  ["Bailey, let's talk about the LoRa monitoring network", "open", { query: "lora monitoring network" }],
  ["Open the artwork timeline idea.", "open", { query: "artwork timeline" }],
  ["Back to the Raspberry Pi display.", "open", { query: "raspberry pi display" }],
  ["Okay, switch to the air quality alerts.", "open", { query: "air quality alerts", verb: "switch" }],
  ["Yes.", "yes"], ["Yeah, that's it.", "yes"], ["No.", "no"], ["Neither of them.", "no"], ["The second one.", "pick", { index: 1 }], ["First.", "pick", { index: 0 }],
  ["Add a note: try a streak freeze after two missed days.", "note", { text: "try a streak freeze after two missed days." }],
  ["At a note, try a streak freeze after two missed days.", "note", { text: "try a streak freeze after two missed days." }],
  ["Take a note that the battery should last a month", "note", { text: "the battery should last a month" }],
  ["Make this a skill.", "skill"], ["Add this as a skill", "skill"],
  ["What's its evaluation?", "evaluation"], ["What are the scores?", "evaluation"], ["How did it score?", "evaluation"],
  ["Close.", "close"], ["We're done.", "close"], ["Done for now.", "close"], ["That's all.", "close"],
  ["Bailey, capture a new idea: a solar powered soil sensor.", "capture", { content: "a solar powered soil sensor." }],
  ["New idea: open source bird feeder camera", "capture"],
  ["What is the boiling point of water?", "question"], ["How should I handle missed days?", "question"],
  ["No, I think the battery matters more than the screen because it runs outside all year long.", "question"],
  ["Open source licenses, what do they mean?", "open"] // documented ambiguity: "open X" always means open-idea
];
for (const [text, kind, fields] of cases) {
  const r: any = parseIntent(text);
  const ok = r.kind === kind && Object.entries(fields ?? {}).every(([k, v]) => r[k] === v);
  check(`intent "${text}" -> ${kind}`, ok, ok ? "" : JSON.stringify(r));
}

// ---------- pure helpers ----------
{
  const facts: Fact[] = [{ tag: "F1", text: "Streak freezes reduce churn.", source: "research", sim: 0.7 }, { tag: "F2", text: "x", source: "skill", sim: 0.5 }];
  const g = finishGrounded("Streak freezes help keep users [F1]. Keep it simple [F1, F2].", facts);
  check("finishGrounded strips tags + says basis", g.text === "From your research: Streak freezes help keep users. Keep it simple." && g.used.join() === "F1,F2", g.text);
  const g2 = finishGrounded("I don't have research on that.", facts);
  check("finishGrounded leaves ungrounded answers alone", g2.text === "I don't have research on that." && g2.used.length === 0);
  const g4 = finishGrounded("Get back on track [IDEA]. Then rest [EVALUATION].", facts); check("finishGrounded strips stray [IDEA] labels", g4.text === "Get back on track. Then rest.", g4.text);
  const g3 = finishGrounded("Fake tag [F9].", facts); check("finishGrounded ignores unknown tags", g3.used.length === 0 && g3.text === "Fake tag.", g3.text);
  const s = groundSummary("Richard discussed streak freezes for missed days. He decided on lunar mining robots.", "Richard: how do streak freezes work for missed days?");
  check("groundSummary keeps grounded, drops invented sentence", s.kept.length === 1 && s.dropped.length === 1, JSON.stringify(s));
  const d = decideMatch([{ id: "a", title: "A", score: 0.8 }, { id: "b", title: "B", score: 0.62 }]);
  const d2 = decideMatch([{ id: "a", title: "A", score: 0.62 }, { id: "b", title: "B", score: 0.6 }]);
  const d3 = decideMatch([{ id: "a", title: "A", score: 0.3 }]);
  check("decideMatch confident / ambiguous / none", d.kind === "confident" && d2.kind === "ambiguous" && d2.top.length === 2 && d3.kind === "none");
  const b = buildContext({ title: "T", content: "C", evaluation: { feasibility: 4, cost: 3, relevance: 5, novelty: 2, summary: "S." }, facts, recent: [{ id: "1", session_id: "s", role: "note", text: "my note", channel: "web", created_at: 0 }], summary: "Earlier summary." }, "Q?");
  check("buildContext includes idea, eval, summary, tagged facts, cross-channel notes", ["IDEA: T", "feasibility 4, cost 3", "EARLIER CONVERSATIONS: Earlier summary.", "[F1] Streak", "NOTE (web): my note"].every(x => b.system.includes(x)) && b.user === "Q?");
}

// ---------- real DB copy ----------
const db = new Database(dbPath); db.pragma("journal_mode = WAL"); db.pragma("busy_timeout = 5000"); ensureConversationTables(db);
const before = conversationCounts(db);
const { embedTexts, generateResponse } = await import("./ai.js");
const MODEL = process.env.VOICE_MODEL ?? "gemma4:e4b-it-qat";
let clock = Date.now(); const skillCalls: string[] = [];
const ex = createExplorer({
  db, model: MODEL, embed: xs => embedTexts(xs),
  llm: (m, o) => generateResponse(m, { model: MODEL, think: false, temperature: o?.temperature ?? 0.3, numPredict: o?.numPredict ?? 150, numCtx: 4096, timeoutMs: 90_000 }),
  captureIdea: async c => ({ id: "fake", title: c }), createSkill: async id => { skillCalls.push(id); return { status: 202, body: { skillId: "x" } }; },
  generalAnswer: async () => "general answer", now: () => clock, log: (...a) => console.log("   log:", ...a.map(String))
});
const byTitle = (t: string) => db.prepare(`SELECT id FROM ideas WHERE title LIKE ?`).pluck().get(t + "%") as string;

// matching on the real 39 ideas
const expect: Array<[string, string, "confident" | "ambiguous" | "none" | "top2"]> = [
  ["habit tracker", "Habit tracker with small next actions", "confident"],
  ["habit tracker with small next actions", "Habit tracker with small next actions", "confident"],
  ["raspberry pi portrait display", "I want to be able to use my Raspberrypi 5", "confident"],
  ["artwork timeline", "Personalized Artwork Timeline Generator", "confident"],
  ["lora environmental monitoring", "LoRa Environmental Monitoring Network", "confident"],
  ["fire risk warning", "Real-time Fire Risk Early Warning System", "top2"],
  ["drought stress", "Real-time Drought Stress Detection", "top2"],
  ["wildlife health", "Wildlife Health Stress Index Tracker", "top2"],
  ["shared sticky notes", "Real-Time Shared Sticky Notes", "top2"],
  ["motion sensor privacy", "Adaptive Privacy Shield for Motion", "top2"],
  ["streak recovery", "", "ambiguous"],
  ["air quality", "", "ambiguous"],
  ["quantum banana spaceship", "", "none"]
];
for (const [q, title, want] of expect) {
  const t0 = Date.now(); const m = await ex.match(q); const ms = Date.now() - t0;
  const top = m.ranked.slice(0, 2).map(r => `${r.score.toFixed(3)} ${r.title.slice(0, 40)}`).join(" | ");
  let ok: boolean;
  if (want === "confident") ok = m.kind === "confident" && m.top[0]!.title.startsWith(title);
  else if (want === "top2") ok = m.kind !== "none" && m.top.some(t => t.title.startsWith(title));
  else ok = m.kind === want;
  check(`match "${q}" -> ${want}${title ? " " + title.slice(0, 30) : ""}`, ok, `${m.kind} ${ms}ms: ${top}`);
}

// context building on a real idea with findings
{
  const id = byTitle("Habit tracker with small next actions");
  const ctx = await ex.loadContext(id, "How should the app handle missed days?");
  check("loadContext: evaluation + verified research facts ranked by similarity", !!ctx.evaluation && ctx.facts.length >= 1 && ctx.facts.every((f, i, a) => f.sim >= 0.45 && (i === 0 || a[i - 1]!.sim >= f.sim)) && ctx.facts[0]!.tag === "F1",
    `facts=${ctx.facts.length} top=${ctx.facts[0]?.sim.toFixed(3)} "${ctx.facts[0]?.text.slice(0, 70)}"`);
  const art = byTitle("Personalized Artwork Timeline Generator");
  const c2 = await ex.loadContext(art, "What data does the timeline need?");
  check("loadContext: skill key facts included for an idea with a ready skill", c2.facts.some(f => f.source === "skill"), `facts=${c2.facts.map(f => f.source).join(",")}`);
}

// explorer flow (real gemma4): open -> confirm -> recap -> question -> note -> evaluation -> skill -> close -> summary
const DEV = "test:dev:01";
const say = async (t: string) => { const r = await ex.handle(DEV, t); console.log(`   > ${t}\n   < [${r.intent}] ${r.reply}  ${JSON.stringify(r.timings)}`); clock += 5000; return r; };
{
  const habit = byTitle("Habit tracker with small next actions");
  let r = await say("Let's talk about the habit tracker.");
  check("open: confident confirm asks the title", r.intent === "open" && r.reply === "Habit tracker with small next actions?", r.reply);
  r = await say("Yes.");
  check("confirm yes: idea active, recap (no history yet)", r.intent === "recap" && r.ideaId === habit && /haven't talked/.test(r.reply), r.reply);
  r = await say("How should the app handle missed days?");
  check("grounded answer: capped, no tags", r.intent === "grounded" && r.reply.length <= 300 && !/\[F\d/.test(r.reply), r.reply);
  r = await say("Add a note: try a streak freeze after two missed days.");
  check("note saved as note turn", r.reply === "Noted." && ex.store.turns(r.sessionId!).some(t => t.role === "note" && /streak freeze/.test(t.text)));
  r = await say("What's its evaluation?");
  check("evaluation reads scores", /^Feasibility \d, cost \d, relevance \d, novelty \d/.test(r.reply), r.reply);
  r = await say("Make this a skill.");
  check("skill uses createSkill for the active idea", skillCalls.at(-1) === habit && /deep dive/.test(r.reply), r.reply);
  const sid = r.sessionId!;
  r = await say("Close.");
  await ex.flush();
  const s = ex.store.getSession(sid)!; const sum = ex.store.getSummary(habit);
  check("close ends session and writes grounded summary", !!s.ended_at && s.end_reason === "user" && !!sum?.summary, sum?.summary);
  check("summary mentions the note", /streak freeze/i.test(sum?.summary ?? ""));
  // reopen: recap from summary + last messages
  r = await say("Back to the habit tracker.");
  r = await say("Yes.");
  check("reopen recap uses earlier conversation", r.intent === "recap" && !/haven't talked/.test(r.reply) && r.reply.length <= 300, r.reply);
  // ambiguous -> offer two -> pick second
  r = await say("Switch to streak recovery.");
  check("ambiguous: offers top 2", r.intent === "open" && /^Did you mean .+, or .+\?$/.test(r.reply), r.reply);
  const prevSid = r.sessionId!;
  r = await say("The second one.");
  check("pick second activates it and ends the previous idea's session", r.intent === "recap" && r.ideaId !== habit && !!ex.store.getSession(prevSid)?.ended_at || (r.sessionId !== prevSid && !!ex.store.getSession(prevSid)?.ended_at), `idea=${r.ideaId} prev ended=${!!ex.store.getSession(prevSid)?.ended_at}`);
  // no -> second candidate
  r = await say("Open the LoRa environmental monitoring network.");
  r = await say("No.");
  check("no on confirm offers the runner-up", r.intent === "confirm" && /^Or did you mean /.test(r.reply), r.reply);
  r = await say("No.");
  check("second no clears the question", /Which idea/.test(r.reply), r.reply);
  // timeout
  const active = ex.store.activeForDevice(DEV)!;
  clock += 11 * 60 * 1000;
  r = await say("What is the boiling point of water?");
  await ex.flush();
  check("idle > 10 min ends the session; next question is general", !!ex.store.getSession(active.id)?.ended_at && ex.store.getSession(active.id)?.end_reason === "timeout" && r.intent === "general", `reason=${ex.store.getSession(active.id)?.end_reason} intent=${r.intent}`);
  r = await say("What's its evaluation?");
  check("idea-only action without an open idea gives a hint", /Open an idea first/.test(r.reply));
  // sweepIdle path
  await say("Let's talk about the artwork timeline."); await say("Yes."); const sw = ex.store.activeForDevice(DEV)!;
  clock += 11 * 60 * 1000; ex.sweepIdle(); await ex.flush();
  check("sweepIdle closes idle sessions", ex.store.getSession(sw.id)?.end_reason === "timeout");
  r = await say("Bailey, capture a new idea: a solar powered soil sensor.");
  check("new idea capture path still works", r.intent === "capture" && /saved your idea/.test(r.reply));
}
const after = conversationCounts(db);
check("legacy conversation_messages untouched", before.conversation_messages === after.conversation_messages, `${before.conversation_messages} -> ${after.conversation_messages}`);
console.log("counts", JSON.stringify(after));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
