// Local xiaozhi-esp32 compatible voice service (WebSocket protocol v1 + OTA config endpoint).
// Protocol ref: github.com/78/xiaozhi-esp32 @ aab98abd (docs/websocket.md,
// main/protocols/websocket_protocol.cc, main/ota.cc, main/application.cc).
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { Whisper, Piper, createOpusDecoder, encodeOpusFrames, rms, FRAME_MS, SAMPLE_RATE } from "./engines.js";
import { parseCapture, captureIdea, answer, splitSentences } from "./brain.js";
import { filterTranscript, audioGate } from "./filters.js";
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export function lanIPv4(): string | undefined {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (!/^en\d/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

const TOKEN = process.env.VOICE_TOKEN ?? "";
const ALLOWED = new Set((process.env.VOICE_ALLOWED_DEVICES ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const PORT = Number(process.env.VOICE_PORT ?? 8000);
const HOST = process.env.VOICE_HOST ?? lanIPv4() ?? "127.0.0.1";
const PUBLIC_WS = process.env.VOICE_PUBLIC_WS_URL ?? `ws://${HOST}:${PORT}/xiaozhi/v1/`;
const MAX_UTTERANCE_MS = 30_000;
const MAX_TTS_MS = Number(process.env.VOICE_MAX_TTS_MS ?? 20_000);
const MIN_RMS = Number(process.env.VOICE_MIN_RMS ?? 400);
const LOCK_FILE = resolve(process.env.VOICE_LOCK_FILE ?? "logs/voice.pid");

if (TOKEN.length < 16) { console.error("[voice] VOICE_TOKEN must be set (>=16 chars)"); process.exit(1); }
if (ALLOWED.size === 0) { console.error("[voice] VOICE_ALLOWED_DEVICES must list device MACs"); process.exit(1); }

// ---------- single instance (pid lockfile; stale locks from dead pids are taken over) ----------
function acquireLock(): void {
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx"); writeSync(fd, String(process.pid)); closeSync(fd); return;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(LOCK_FILE, "utf8").trim());
      let alive = false; try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (k: any) { alive = k.code === "EPERM"; }
      if (alive) {
        console.error(`[voice] another voice service is already running (pid ${pid}, lock ${LOCK_FILE}). Not starting a second instance.`);
        process.exit(Number(process.env.VOICE_LOCKED_EXIT_CODE ?? 3)); // launchd sets 0 so KeepAlive{SuccessfulExit:false} won't loop
      }
      try { unlinkSync(LOCK_FILE); } catch {}
    }
  }
  console.error(`[voice] could not acquire ${LOCK_FILE}`); process.exit(3);
}
function releaseLock() { try { if (readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_FILE); } catch {} }
acquireLock();

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[voice]", ...a);

function tokenOk(header: string | undefined): boolean {
  if (!header) return false;
  const t = header.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const deviceOk = (id: string | undefined) => !!id && ALLOWED.has(id.toLowerCase());

const whisper = new Whisper();

// Local admin trigger: active sessions + one pending announcement delivered on the next session.
interface ActiveSession { deviceId: string; announce(text: string): Promise<boolean> }
const sessions = new Map<string, ActiveSession>();
let pendingSay: { text: string; expires: number } | null = null;
const ADMIN_PORT = Number(process.env.VOICE_ADMIN_PORT ?? 8001);
function takePending(): string | null {
  if (pendingSay && pendingSay.expires > Date.now()) { const t = pendingSay.text; pendingSay = null; return t; }
  pendingSay = null; return null;
}
const piper = new Piper();

// ---------- OTA / config endpoint (firmware calls this on boot) ----------
async function handleOta(req: IncomingMessage, res: ServerResponse) {
  const deviceId = req.headers["device-id"] as string | undefined;
  let body = "";
  for await (const c of req) { body += c; if (body.length > 65536) break; }
  if (!deviceOk(deviceId)) {
    log("OTA rejected device", deviceId);
    res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "device not allowed" }));
    return;
  }
  let current = "0.0.0";
  try { current = JSON.parse(body)?.application?.version ?? current; } catch {}
  const now = Date.now();
  const payload = {
    server_time: { timestamp: now, timezone_offset: -new Date().getTimezoneOffset() },
    // Echo the running version back with no url so the device never self-updates from here.
    firmware: { version: current, url: "" },
    websocket: { url: PUBLIC_WS, token: TOKEN, version: 1 }
  };
  log("OTA ok", deviceId, "fw", current);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
}

const http = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path.startsWith("/xiaozhi/ota")) { handleOta(req, res).catch(e => { log("OTA error", e); res.writeHead(500).end(); }); return; }
  if (path === "/health") { res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
  res.writeHead(404).end();
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
http.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "").split("?")[0];
  const deviceId = req.headers["device-id"] as string | undefined;
  const version = String(req.headers["protocol-version"] ?? "1");
  let reason = "";
  if (!path.startsWith("/xiaozhi/v1")) reason = "404 Not Found";
  else if (!tokenOk(req.headers["authorization"] as string | undefined)) reason = "401 Unauthorized";
  else if (!deviceOk(deviceId)) reason = "403 Forbidden";
  else if (version !== "1") reason = "400 Bad Request"; // only binary protocol v1 (raw Opus) is implemented
  if (reason) {
    log("WS rejected", deviceId, reason);
    socket.write(`HTTP/1.1 ${reason}\r\nConnection: close\r\n\r\n`); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => session(ws, deviceId!, String(req.headers["client-id"] ?? "")));
});

function session(ws: WebSocket, deviceId: string, clientId: string) {
  const sessionId = randomUUID();
  const decoder = createOpusDecoder();
  let helloDone = false;
  let listening = false;
  let mode = "manual";
  let pcm: Buffer[] = [];
  let pcmMs = 0;
  let heardSpeech = false;
  let silentMs = 0;
  let busy = false;
  let abortFlag = false;
  log("connected", deviceId, clientId, sessionId);
  const announce = async (text: string): Promise<boolean> => {
    if (busy || ws.readyState !== ws.OPEN) return false;
    busy = true; listening = false; abortFlag = false; pcm = []; pcmMs = 0;
    try { const ms = await speak(text); log(`announce spoken in ${ms}ms`, JSON.stringify(text)); return true; }
    finally { busy = false; }
  };
  sessions.set(sessionId, { deviceId, announce });

  const send = (o: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ session_id: sessionId, ...o })); };

  async function speak(text: string) {
    send({ type: "tts", state: "start" });
    const t0 = Date.now(); let framesSent = 0; const maxFrames = Math.floor(MAX_TTS_MS / FRAME_MS);
    for (const sentence of splitSentences(text)) {
      if (abortFlag || framesSent >= maxFrames) break;
      const audio = await piper.synthesize(sentence);
      const frames = encodeOpusFrames(audio);
      send({ type: "tts", state: "sentence_start", text: sentence });
      // Pace roughly in real time with a small lead so the device's decode queue doesn't overflow.
      const start = Date.now();
      for (let i = 0; i < frames.length; i++) {
        if (abortFlag || ws.readyState !== ws.OPEN) break;
        if (framesSent >= maxFrames) { log(`tts capped at ${MAX_TTS_MS}ms`); break; }
        ws.send(frames[i], { binary: true }); framesSent++;
        const ahead = (i - 5) * FRAME_MS - (Date.now() - start);
        if (ahead > 0) await sleep(ahead);
      }
    }
    send({ type: "tts", state: "stop" });
    log(`tts sent ${framesSent} opus frames${abortFlag ? " (aborted)" : ""}`);
    return Date.now() - t0;
  }

  // Ignore path: say nothing; tell the device TTS is over so it drops back to idle (or re-listens in auto mode).
  function idle() { send({ type: "tts", state: "stop" }); }

  async function finishUtterance() {
    if (busy) return;
    listening = false; busy = true; abortFlag = false;
    const audio = Buffer.concat(pcm); pcm = []; pcmMs = 0; heardSpeech = false; silentMs = 0;
    const t = { start: Date.now(), stt: 0, llm: 0, tts: 0 };
    try {
      const gate = audioGate(audio, { rmsThreshold: MIN_RMS, sampleRate: SAMPLE_RATE });
      if (!gate.ok) { log(`ignored before STT: ${gate.reason} (${Math.round(gate.durationMs)}ms, voiced ${gate.voicedMs}ms)`); idle(); return; }
      const rawText = await whisper.transcribe(audio);
      t.stt = Date.now() - t.start;
      const { text, reason } = filterTranscript(rawText);
      if (!text) { log(`ignored transcript (${reason}):`, JSON.stringify(rawText)); idle(); return; }
      send({ type: "stt", text });
      const t1 = Date.now();
      let reply: string; let emotion = "neutral";
      const idea = parseCapture(text);
      if (idea) {
        try { const r = await captureIdea(idea); reply = `Got it. I saved your idea: ${r.title}.`; emotion = "happy"; log("idea created", r.id); }
        catch (e) { log("capture failed", e); reply = "Sorry, I couldn't save that idea."; emotion = "sad"; }
      } else {
        reply = await answer(text);
      }
      t.llm = Date.now() - t1;
      send({ type: "llm", emotion, text: emotion === "happy" ? "😊" : emotion === "sad" ? "😔" : "🙂" });
      t.tts = await speak(reply);
      log(`timing stt=${t.stt}ms brain=${t.llm}ms tts=${t.tts}ms total=${Date.now() - t.start}ms`, JSON.stringify({ text, reply }));
    } catch (e) {
      log("pipeline error", e);
      try { await speak("Sorry, something went wrong."); } catch {}
    } finally { busy = false; }
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!helloDone || !listening || busy) return;
      let frame: Buffer;
      try { frame = decoder.decode(data as Buffer); } catch { return; }
      pcm.push(frame); pcmMs += FRAME_MS;
      // Simple energy VAD for "auto"/"realtime" mode: end after 800 ms of silence following speech.
      if (mode !== "manual") {
        if (rms(frame) > 500) { heardSpeech = true; silentMs = 0; } else if (heardSpeech) silentMs += FRAME_MS;
        if (heardSpeech && silentMs >= 800) void finishUtterance();
      }
      if (pcmMs >= MAX_UTTERANCE_MS) void finishUtterance();
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case "hello":
        if (msg.transport && msg.transport !== "websocket") { ws.close(1002, "transport"); return; }
        helloDone = true;
        send({ type: "hello", transport: "websocket", audio_params: { format: "opus", sample_rate: SAMPLE_RATE, channels: 1, frame_duration: FRAME_MS } });
        break;
      case "listen":
        if (msg.state === "start") {
          mode = msg.mode ?? "manual"; listening = true; if (!busy) abortFlag = false; pcm = []; pcmMs = 0; heardSpeech = false; silentMs = 0;
          const say = takePending();
          if (say) void announce(say);
        }
        else if (msg.state === "stop") { if (listening) void finishUtterance(); }
        else if (msg.state === "detect") {
          log("wake word", msg.text);
          const say = takePending();
          if (say) void announce(say);
        }
        break;
      case "abort": abortFlag = true; log("abort", msg.reason); break;
      case "mcp": break; // device tool discovery; not used yet
      default: log("unhandled message type", msg.type);
    }
  });
  ws.on("close", () => { sessions.delete(sessionId); abortFlag = true; decoder.delete(); log("disconnected", deviceId); });
  ws.on("error", e => log("ws error", e.message));
}

// POST http://127.0.0.1:VOICE_ADMIN_PORT/admin/say  {"text": "..."}  Authorization: Bearer VOICE_TOKEN
// Speaks now on an open session; otherwise queues it (2 min) for the next session's wake-word detect.
const admin = createServer(async (req, res) => {
  const reply = (code: number, o: unknown) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(o));
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/admin/say") return reply(404, { error: "not found" });
  if (!tokenOk(req.headers["authorization"] as string | undefined)) return reply(401, { error: "unauthorized" });
  let body = ""; for await (const c of req) { body += c; if (body.length > 4096) return reply(413, { error: "too large" }); }
  let text = ""; try { text = String(JSON.parse(body).text ?? "").trim().slice(0, 500); } catch {}
  if (!text) return reply(400, { error: "text required" });
  for (const s of sessions.values()) {
    if (await s.announce(text)) return reply(200, { status: "spoken", device: s.deviceId });
  }
  pendingSay = { text, expires: Date.now() + 120_000 };
  log("announce queued for next session", JSON.stringify(text));
  reply(202, { status: "queued", note: "no open session; will speak on next wake word/button session (2 min)" });
});

async function main() {
  log("starting speech engines (whisper-server + piper)...");
  const t0 = Date.now();
  await Promise.all([whisper.start(), piper.start()]);
  log(`engines warm in ${Date.now() - t0}ms`);
  admin.listen(ADMIN_PORT, "127.0.0.1", () => log(`admin trigger on http://127.0.0.1:${ADMIN_PORT}/admin/say`));
  http.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (OTA /xiaozhi/ota/, WS ${PUBLIC_WS})`));
}
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return; shuttingDown = true;
  http.close(); admin.close();
  // Wait (max 8 s) for the children to exit before exiting ourselves; the watchdogs cover anything left.
  void Promise.race([Promise.all([whisper.stop(), piper.stop()]), sleep(8000)])
    .finally(() => { releaseLock(); process.exit(code); });
};
process.on("SIGINT", () => shutdown(0)); process.on("SIGTERM", () => shutdown(0)); process.on("SIGHUP", () => shutdown(0));
process.on("exit", () => { void whisper.stop(); void piper.stop(); releaseLock(); });
process.on("uncaughtException", e => { console.error("[voice] uncaught", e); shutdown(1); });
http.on("error", (e: any) => { console.error(`[voice] HTTP ${HOST}:${PORT} failed: ${e.code === "EADDRINUSE" ? "port already in use (another voice service?)" : e.message}`); shutdown(3); });
admin.on("error", (e: any) => { console.error(`[voice] admin 127.0.0.1:${ADMIN_PORT} failed: ${e.code === "EADDRINUSE" ? "port already in use" : e.message}`); shutdown(3); });
main().catch(e => { console.error("[voice] startup failed:", e instanceof Error ? e.message : e); shutdown(1); });
