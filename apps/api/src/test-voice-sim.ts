// Simulated xiaozhi device: OTA call, hello handshake, streams Piper speech as 60 ms Opus frames,
// checks stt / llm / tts messages and that returned Opus decodes to audible PCM.
// Requires a running voice service (npm run voice). Env: VOICE_SIM_URL (http://IP:8000), VOICE_TOKEN,
// VOICE_SIM_DEVICE (an allowlisted MAC).
import "dotenv/config";
import { execFileSync } from "node:child_process";
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

async function utterance(ws: WebSocket, text: string, timeoutMs = 240_000) {
  const pcm = speechPcm(text);
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
    else check(`[question] reply mentions 212`, sentences.join(" ").includes("212"), sentences.join(" | "));
    console.log(`LATENCY [${label}] speech=${r.speechMs}ms stt=${r.sttMs}ms brain=${r.brainMs}ms first_audio=${r.firstAudioMs}ms total(after stop -> tts stop)=${r.totalMs}ms`);
  }
  ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
