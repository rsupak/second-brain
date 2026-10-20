// Simulated xiaozhi device: OTA call, hello handshake, streams Piper speech as 60 ms Opus frames,
// checks stt / llm / tts messages and that returned Opus decodes to audible PCM.
// Requires a running voice service (npm run voice). Env: VOICE_SIM_URL (http://IP:8000), VOICE_TOKEN,
// VOICE_SIM_DEVICE (an allowlisted MAC).
import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { encodeOpusFrames, createOpusDecoder, rms, FRAME_MS } from "./voice/engines.js";

const BASE = process.env.VOICE_SIM_URL ?? "http://127.0.0.1:8000";
const TOKEN = process.env.VOICE_TOKEN ?? "";
const DEVICE = process.env.VOICE_SIM_DEVICE ?? "d0:cf:13:05:43:f8";
const TOOLS = join(homedir(), "Projects/voice-tools");
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); };

function speechPcm(text: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "voice-sim-"));
  execFileSync(join(TOOLS, ".venv/bin/piper"), ["-m", join(TOOLS, "voices/en_US-lessac-medium.onnx"), "-f", join(dir, "a.wav"), "--", text], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "a.wav"), "-ar", "16000", "-ac", "1", "-f", "s16le", join(dir, "a.pcm")]);
  return readFileSync(join(dir, "a.pcm"));
}

function connect(headers: Record<string, string>): Promise<{ ws?: WebSocket; status?: number }> {
  return new Promise(resolve => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/xiaozhi/v1/", { headers });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_r, res) => resolve({ status: res.statusCode }));
    ws.on("error", () => resolve({ status: -1 }));
  });
}

async function utterance(ws: WebSocket, text: string | Buffer, timeoutMs = 240_000) {
  const pcm = typeof text === "string" ? speechPcm(text) : text;
  const frames = encodeOpusFrames(Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 0.3)]));
  const msgs: any[] = []; const audio: Buffer[] = [];
  const dec = createOpusDecoder();
  let firstAudioAt = 0, sttAt = 0, llmAt = 0;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    ws.on("message", function onMsg(data, bin) {
      if (bin) { if (!firstAudioAt) firstAudioAt = Date.now(); audio.push(dec.decode(data as Buffer)); return; }
      const m = JSON.parse(data.toString()); msgs.push(m);
      if (m.type === "stt") sttAt = Date.now();
      if (m.type === "llm") llmAt = Date.now();
      if (m.type === "tts" && m.state === "stop") { clearTimeout(timer); ws.off("message", onMsg); resolve(); }
    });
  });
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
  const t0 = Date.now();
  for (const f of frames) { ws.send(f); await new Promise(r => setTimeout(r, FRAME_MS)); } // real-time, as if spoken
  const stopAt = Date.now();
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  await done;
  const end = Date.now(); dec.delete();
  const out = Buffer.concat(audio);
  return { msgs, out, speechMs: stopAt - t0, sttMs: sttAt - stopAt, brainMs: llmAt - sttAt, firstAudioMs: firstAudioAt - stopAt, totalMs: end - stopAt };
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
function wordAcc(ref: string, hyp: string) { const h = new Set(words(hyp)); const r = words(ref); return r.filter(w => h.has(w)).length / r.length; }

async function main() {
  // Negative auth checks
  const badOta = await fetch(BASE + "/xiaozhi/ota/", { method: "POST", headers: { "Device-Id": "00:11:22:33:44:55", "content-type": "application/json" }, body: "{}" });
  check("OTA rejects unknown device", badOta.status === 403, `status=${badOta.status}`);
  const badTok = await connect({ Authorization: "Bearer wrong-token-xxxxxxxxxx", "Protocol-Version": "1", "Device-Id": DEVICE, "Client-Id": "sim" });
  check("WS rejects bad token", badTok.status === 401, `status=${badTok.status}`);
  const badDev = await connect({ Authorization: `Bearer ${TOKEN}`, "Protocol-Version": "1", "Device-Id": "00:11:22:33:44:55", "Client-Id": "sim" });
  check("WS rejects unknown device", badDev.status === 403, `status=${badDev.status}`);

  // OTA like firmware boot
  const ota = await fetch(BASE + "/xiaozhi/ota/", { method: "POST", headers: { "Device-Id": DEVICE, "Client-Id": "sim-uuid", "Activation-Version": "1", "content-type": "application/json" },
    body: JSON.stringify({ application: { version: "1.6.0" } }) });
  const otaJson: any = await ota.json();
  check("OTA 200 with websocket url+token+version", ota.status === 200 && otaJson.websocket?.url?.startsWith("ws://") && otaJson.websocket?.token === TOKEN && otaJson.websocket?.version === 1, otaJson.websocket?.url);
  check("OTA firmware echoes version (no update)", otaJson.firmware?.version === "1.6.0" && otaJson.firmware?.url === "");
  check("OTA server_time present", typeof otaJson.server_time?.timestamp === "number");

  // Hello handshake using the token handed out by OTA (firmware adds "Bearer ")
  const { ws } = await connect({ Authorization: `Bearer ${otaJson.websocket.token}`, "Protocol-Version": "1", "Device-Id": DEVICE, "Client-Id": "sim-uuid" });
  check("WS connects with valid token+device", !!ws);
  if (!ws) throw new Error("no ws");
  const hello: any = await new Promise(r => { ws.once("message", d => r(JSON.parse(d.toString()))); ws.send(JSON.stringify({ type: "hello", version: 1, features: { mcp: true }, transport: "websocket", audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 } })); });
  check("server hello transport=websocket + session_id", hello.type === "hello" && hello.transport === "websocket" && !!hello.session_id);
  check("server hello audio_params opus/16000/1/60", hello.audio_params?.format === "opus" && hello.audio_params?.sample_rate === 16000 && hello.audio_params?.channels === 1 && hello.audio_params?.frame_duration === 60);

  for (const [label, text, isIdea] of [
    ["idea", "Bailey, capture a new idea: a solar powered soil moisture sensor that sends weekly reports to my phone.", true],
    ["question", "What is the boiling point of water in Fahrenheit?", false]
  ] as const) {
    const r = await utterance(ws, text);
    const stt = r.msgs.find(m => m.type === "stt"); const llm = r.msgs.find(m => m.type === "llm");
    const states = r.msgs.filter(m => m.type === "tts").map(m => m.state);
    const sentences = r.msgs.filter(m => m.type === "tts" && m.state === "sentence_start").map(m => m.text);
    const acc = stt ? wordAcc(text, stt.text) : 0;
    check(`[${label}] stt received, word accuracy >= 0.9`, !!stt && acc >= 0.9, `acc=${acc.toFixed(2)} "${stt?.text}"`);
    check(`[${label}] llm emotion message`, !!llm?.emotion, llm?.emotion);
    check(`[${label}] tts start -> sentence_start -> stop order`, states[0] === "start" && states.includes("sentence_start") && states.at(-1) === "stop", states.join(","));
    check(`[${label}] all messages carry session_id`, r.msgs.every(m => m.session_id === hello.session_id));
    const level = rms(r.out);
    check(`[${label}] Opus reply decodes to audible PCM`, r.out.length > 16000 * 2 * 0.5 && level > 300, `${(r.out.length / 32000).toFixed(2)}s rms=${level.toFixed(0)}`);
    if (isIdea) check(`[idea] reply confirms saved idea`, sentences.join(" ").includes("saved your idea"), sentences.join(" | "));
    else {
      check(`[question] reply mentions 212`, sentences.join(" ").includes("212"), sentences.join(" | "));
      const said = sentences.join(" ");
      check(`[question] reply capped (<=3 sentences, <=300 chars, no reasoning)`, sentences.length <= 3 && said.length <= 300 && !/the user|i need to|<\/?think>/i.test(said), `${sentences.length} sentences, ${said.length} chars`);
    }
    console.log(`LATENCY [${label}] speech=${r.speechMs}ms stt=${r.sttMs}ms brain=${r.brainMs}ms first_audio=${r.firstAudioMs}ms total(after stop -> tts stop)=${r.totalMs}ms`);
  }

  // ---------- idea exploration (only against a test service on a DB copy: VOICE_SIM_EXPLORE_DB) ----------
  const exploreDb = process.env.VOICE_SIM_EXPLORE_DB;
  if (exploreDb) {
    const { resolve } = await import("node:path");
    if (resolve(exploreDb) === resolve("data/brain.sqlite")) throw new Error("VOICE_SIM_EXPLORE_DB must be a copy");
    const transcript: string[] = [];
    const turn = async (label: string, text: string) => {
      const r = await utterance(ws, text);
      const stt = r.msgs.find(m => m.type === "stt")?.text ?? "";
      const said = r.msgs.filter(m => m.type === "tts" && m.state === "sentence_start").map(m => m.text).join(" ");
      transcript.push(`Richard (stt): ${stt}`, `Bailey: ${said}`);
      console.log(`LATENCY [explore:${label}] stt=${r.sttMs}ms brain=${r.brainMs}ms first_audio=${r.firstAudioMs}ms total=${r.totalMs}ms`);
      return { ...r, stt, said };
    };
    // Web chat on the idea first (test API, same DB copy): the voice recap must include it.
    const API = process.env.VOICE_API_URL ?? "http://127.0.0.1:3433";
    const jpost = async (path: string, body: unknown) => { const r = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
    const { default: Db0 } = await import("better-sqlite3"); const db0 = new Db0(exploreDb, { readonly: true });
    const habitId = db0.prepare(`SELECT id FROM ideas WHERE title LIKE 'Habit tracker%'`).pluck().get() as string; db0.close();
    const ws1 = await jpost("/chat/sessions", { ideaId: habitId });
    const wm = await jpost(`/chat/sessions/${ws1.body.session.id}/messages`, { text: "Could the habit tracker send a weekly email digest of my streaks?" });
    transcript.push(`[web] Richard: Could the habit tracker send a weekly email digest of my streaks?`, `[web] Bailey: ${wm.body.messages?.find((m: any) => m.role === "assistant")?.text?.replace(/\s+/g, " ")}`);
    const wc = await jpost(`/chat/sessions/${ws1.body.session.id}/close`, {});
    check("[web] chat on the idea answered and closed", wm.status === 200 && wc.body.closed === true, `${wm.status} ${JSON.stringify(wc.body)}`);
    { const { default: Db1 } = await import("better-sqlite3"); const d1 = new Db1(exploreDb, { readonly: true }); const t0 = Date.now(); let sm: string | undefined;
      while (Date.now() - t0 < 90_000) { sm = d1.prepare(`SELECT summary FROM idea_conversation_summaries WHERE idea_id = ?`).pluck().get(habitId) as string | undefined; if (sm) break; await new Promise(r => setTimeout(r, 1000)); }
      d1.close(); check("[web] summary written after web close", !!sm, sm); transcript.push(`[web summary] ${sm}`); }
    const open = await turn("open", "Let's talk about the habit tracker.");
    check("[explore] open -> confirm title aloud", open.said === "Habit tracker with small next actions?", open.said);
    const yes = await turn("confirm", "Yes, that's it.");
    check("[explore] confirm -> recap", /^Okay, Habit tracker with small next actions\./.test(yes.said) && yes.said.length <= 300, yes.said);
    check("[explore] voice recap includes the web chat (email digest)", /e-?mail|digest/i.test(yes.said), yes.said);
    const q = await turn("question", "How should the app handle missed days?");
    check("[explore] grounded question answered within caps", q.said.length > 0 && q.said.length <= 300 && !/\[F\d/.test(q.said) && !/the user (is|wants|asked)|i need to|<\/?think>/i.test(q.said), q.said);
    const note = await turn("note", "Add a note: try a streak freeze after two missed days.");
    check("[explore] note acknowledged", note.said === "Noted.", note.said);
    const mk = await turn("make_idea", "Make this an idea.");
    check("[explore] 'make this an idea' reads the title back and asks", /^The idea is: .+\. Save it\?$/.test(mk.said), mk.said);
    const mky = await turn("make_idea_yes", "Yes.");
    check("[explore] yes -> saved via POST /ideas", /^Saved\./.test(mky.said), mky.said);
    const close = await turn("close", "Close.");
    check("[explore] close acknowledged", /closing Habit tracker/.test(close.said), close.said);
    const Database = (await import("better-sqlite3")).default; const db = new Database(exploreDb, { readonly: true });
    let summary: string | undefined; const t0 = Date.now();
    while (Date.now() - t0 < 120_000) { summary = db.prepare(`SELECT s.summary FROM idea_conversation_summaries s JOIN ideas i ON i.id = s.idea_id WHERE i.title LIKE 'Habit tracker%'`).pluck().get() as string | undefined; if (summary) break; await new Promise(r => setTimeout(r, 2000)); }
    const sess = db.prepare(`SELECT * FROM conversation_sessions WHERE device_id = ? ORDER BY started_at DESC LIMIT 1`).get(DEVICE) as any;
    const turns = sess ? db.prepare(`SELECT role, text, channel FROM conversation_turns WHERE session_id = ? ORDER BY created_at, rowid`).all(sess.id) as any[] : [];
    check("[explore] session persisted: closed by user, user/assistant/note turns on voice channel", sess?.end_reason === "user" && turns.some(t => t.role === "note" && /streak freeze/i.test(t.text)) && turns.every(t => t.channel === "voice") && turns.filter(t => t.role === "user").length >= 1, `${sess?.end_reason} ${turns.map(t => t.role).join(",")}`);
    check("[explore] summary written after close", !!summary, `${Date.now() - t0}ms: ${summary}`);
    const links = sess ? db.prepare(`SELECT kind FROM conversation_links WHERE session_id = ?`).pluck().all(sess.id) as string[] : [];
    check("[explore] voice session linked to the created idea", links.includes("created_idea"), links.join(","));
    db.close();
    // Topic skill (queued only, no worker on the copy) can be opened by voice by its name.
    const tsk = await jpost("/skills/topic", { topic: "Zettelkasten note linking", seed: "The Zettelkasten method links small atomic notes into a network of ideas." });
    check("[topic] POST /skills/topic queued", tsk.status === 202, JSON.stringify(tsk.body));
    const to = await turn("open_topic", "Let's talk about Zettelkasten note linking.");
    check("[topic] voice opens the topic skill by name", to.said === "Zettelkasten note linking?", to.said);
    const toy = await turn("open_topic_yes", "Yes.");
    check("[topic] confirm -> recap for the topic", /^Okay, Zettelkasten note linking\./.test(toy.said), toy.said);
    await turn("close_topic", "Close.");
    console.log("TRANSCRIPT\n  " + transcript.join("\n  ") + `\n  [summary] ${summary}`);
  }

  // ---------- noise: must be ignored without speaking ----------
  const quiet = Buffer.alloc(16000 * 2 * 1.5); for (let i = 0; i < quiet.length / 2; i++) quiet.writeInt16LE(Math.round((Math.random() - 0.5) * 200), i * 2);
  for (const [label, input] of [["low-energy noise", quiet], ["whisper hallucination 'Thank you.'", "Thank you."]] as const) {
    const r = await utterance(ws, input, 30_000);
    const types = r.msgs.map(m => `${m.type}${m.state ? ":" + m.state : ""}`);
    check(`[noise] ${label} ignored: no stt/llm, no audio, tts stop -> idle`, !r.msgs.some(m => m.type === "stt" || m.type === "llm") && r.out.length === 0 && types.at(-1) === "tts:stop", `${types.join(",")} audio=${r.out.length}B stopAfter=${r.totalMs}ms`);
  }

  // ---------- abort: frames stop immediately ----------
  {
    const pcm = speechPcm("Tell me a story about a dragon who learns to bake bread.");
    const frames = encodeOpusFrames(Buffer.concat([pcm, Buffer.alloc(16000 * 2 * 0.3)]));
    let abortAt = 0, framesBefore = 0, lateFrames = 0, stopAt = 0;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("abort timeout")), 120_000);
      ws.on("message", function onMsg(data, bin) {
        if (bin) {
          if (!abortAt) { framesBefore++; if (framesBefore === 3) { abortAt = Date.now(); ws.send(JSON.stringify({ type: "abort", reason: "wake_word_detected" })); } }
          else if (Date.now() - abortAt > 150) lateFrames++;
          return;
        }
        const m = JSON.parse(data.toString());
        if (m.type === "tts" && m.state === "stop") { stopAt = Date.now(); clearTimeout(timer); ws.off("message", onMsg); resolve(); }
      });
    });
    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    for (const f of frames) { ws.send(f); await new Promise(r => setTimeout(r, FRAME_MS)); }
    ws.send(JSON.stringify({ type: "listen", state: "stop" }));
    await done;
    check("[abort] no audio frames >150 ms after abort, tts stop follows", abortAt > 0 && lateFrames === 0 && stopAt - abortAt < 2000, `late=${lateFrames} stop ${stopAt - abortAt}ms after abort`);
  }

  // ---------- TTS duration cap (admin announce of a very long text) ----------
  {
    const capMs = Number(process.env.VOICE_SIM_MAX_TTS_MS ?? 20000);
    const dec = createOpusDecoder(); const audio: Buffer[] = [];
    const done = new Promise<void>(resolve => ws.on("message", function onMsg(data, bin) {
      if (bin) { audio.push(dec.decode(data as Buffer)); return; }
      const m = JSON.parse(data.toString()); if (m.type === "tts" && m.state === "stop") { ws.off("message", onMsg); resolve(); }
    }));
    const longText = Array.from({ length: 12 }, (_, i) => `This is test sentence number ${i + 1}, which is here only to make the announcement much longer than the cap.`).join(" ").slice(0, 500);
    const res = await fetch(BASE.replace(/:\d+$/, ":" + (process.env.VOICE_ADMIN_PORT ?? "8001")).replace(/\/\/[^:/]+/, "//127.0.0.1") + "/admin/say",
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ text: longText }) });
    await done; dec.delete();
    const secs = Buffer.concat(audio).length / 32000;
    check(`[tts cap] long announce cut at <= ${capMs / 1000}s`, res.status === 200 && secs <= capMs / 1000 + 0.2 && secs > capMs / 1000 - 1.5, `status=${res.status} audio=${secs.toFixed(2)}s`);
  }
  ws.close();

  // ---------- single instance: a second service must refuse to start ----------
  {
    const t0 = Date.now();
    const r = await new Promise<{ code: number | null; err: string }>(resolve => {
      const c = spawn("npx", ["tsx", "apps/api/src/voice/voice-server.ts"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let err = ""; c.stderr.on("data", d => err += d); c.stdout.on("data", d => err += d);
      const kill = setTimeout(() => c.kill("SIGKILL"), 30_000);
      c.on("exit", code => { clearTimeout(kill); resolve({ code, err }); });
    });
    const health = await fetch(BASE + "/health").then(x => x.status, () => -1);
    check("[single instance] second instance exits with clear message, first still healthy", r.code === 3 && /already running/.test(r.err) && health === 200, `exit=${r.code} in ${Date.now() - t0}ms health=${health} msg="${r.err.trim().split("\n")[0]}"`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
