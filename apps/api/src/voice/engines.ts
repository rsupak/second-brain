// Local speech engines for the voice service: whisper-server (STT), a persistent
// Piper worker (TTS) and Opus encode/decode (opusscript, pure JS/WASM, works on arm64).
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { connect } from "node:net";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(import.meta.url);
// opusscript is CommonJS.
const OpusScript = require("opusscript") as any;

export const SAMPLE_RATE = 16000;
export const FRAME_MS = 60;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 960

const HOME = process.env.HOME ?? "";
const VOICE_TOOLS = process.env.VOICE_TOOLS_DIR ?? join(HOME, "Projects/voice-tools");

export function createOpusDecoder() {
  const dec = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  return {
    decode(packet: Buffer): Buffer { return Buffer.from(dec.decode(packet)); },
    delete() { dec.delete(); }
  };
}

/** Encode 16 kHz mono s16le PCM into 60 ms Opus packets (last frame zero-padded). */
export function encodeOpusFrames(pcm: Buffer): Buffer[] {
  const enc = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  const frameBytes = FRAME_SAMPLES * 2;
  const out: Buffer[] = [];
  try {
    for (let off = 0; off < pcm.length; off += frameBytes) {
      let frame = pcm.subarray(off, off + frameBytes);
      if (frame.length < frameBytes) frame = Buffer.concat([frame, Buffer.alloc(frameBytes - frame.length)]);
      out.push(Buffer.from(enc.encode(frame, FRAME_SAMPLES)));
    }
  } finally { enc.delete(); }
  return out;
}

export function pcmToWav(pcm: Buffer, rate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function rms(pcm: Buffer): number {
  let s = 0; const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; }
  return n ? Math.sqrt(s / n) : 0;
}

/** Spawn a child plus a detached watchdog that stops it if this process dies (even by SIGKILL).
 *  SIGINT first, SIGKILL only after 30 s: an early SIGKILL during Metal teardown can leave whisper-server stuck in exit (UE). */
function spawnTied(cmd: string, args: string[], opts: Parameters<typeof spawn>[2]): ChildProcess {
  const child = spawn(cmd, args, opts);
  if (child.pid) {
    const dog = spawn("/bin/sh", ["-c",
      'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 2; done; kill -INT "$2" 2>/dev/null; n=0; while kill -0 "$2" 2>/dev/null && [ $n -lt 30 ]; do sleep 1; n=$((n+1)); done; kill -9 "$2" 2>/dev/null; exit 0',
      "voice-watchdog", String(process.pid), String(child.pid)], { detached: true, stdio: "ignore" });
    dog.unref();
  }
  return child;
}

// whisper-server gets SIGINT: on macOS a SIGTERM'd whisper-server can hang in kernel exit (state UE) after Metal use.
function killChild(p?: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>(res => p.once("exit", () => res()));
  if (!(p as any).__stopSent) { (p as any).__stopSent = true; try { p.kill(signal); } catch {} }
  return exited;
}

// ---------- whisper-server (kept warm on 127.0.0.1) ----------
export class Whisper {
  private proc?: ChildProcess;
  readonly url: string;
  constructor() {
    this.url = process.env.WHISPER_SERVER_URL ?? `http://127.0.0.1:${process.env.WHISPER_PORT ?? "8178"}`;
  }
  async start() {
    if (!process.env.WHISPER_SERVER_URL) {
      const u = new URL(this.url);
      const busy = await new Promise<boolean>(res => {
        const sock = connect(Number(u.port), u.hostname); sock.setTimeout(1000);
        sock.once("connect", () => { sock.destroy(); res(true); });
        sock.once("error", () => res(false)); sock.once("timeout", () => { sock.destroy(); res(false); });
      });
      if (busy) throw new Error(`${this.url} is already in use (orphaned whisper-server?). Stop it first: pkill -f "whisper-server.*--port ${new URL(this.url).port}"`);
      const model = process.env.WHISPER_MODEL ?? join(VOICE_TOOLS, "models/ggml-small.en-q5_1.bin");
      const port = new URL(this.url).port;
      this.proc = spawnTied(process.env.WHISPER_SERVER_BIN ?? "whisper-server",
        ["-m", model, "--host", "127.0.0.1", "--port", port, "-t", "4", "-l", "en"],
        // stderr ignored, not piped: a pipe whose reader (this process) is gone left whisper-server hung in exit (UE).
        { stdio: ["ignore", "ignore", "ignore"] });
      this.proc.on("exit", code => console.error(`[voice] whisper-server exited (${code})`));
    }
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(this.url + "/"); if (r.ok || r.status === 404) break; } catch {}
      await sleep(250);
    }
    // Warm-up pass so the first real request doesn't pay Metal shader compilation.
    await this.transcribe(Buffer.alloc(SAMPLE_RATE * 2)).catch(() => {});
  }
  async transcribe(pcm: Buffer): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");
    const res = await fetch(this.url + "/inference", { method: "POST", body: form });
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`);
    const json = await res.json() as { text?: string };
    return (json.text ?? "").replace(/\s+/g, " ").trim(); // raw; filterTranscript() decides what is noise
  }
  /** Resolves once whisper-server has exited. Exiting the parent before that left it hung in exit (UE) on macOS. */
  stop(): Promise<void> { return killChild(this.proc, "SIGINT"); }
}

// ---------- Piper (persistent python worker) ----------
export class Piper {
  private proc?: ChildProcess;
  private pending = new Map<number, (r: any) => void>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  async start() {
    const py = process.env.PIPER_PYTHON ?? join(VOICE_TOOLS, ".venv/bin/python");
    const voice = process.env.PIPER_VOICE ?? join(VOICE_TOOLS, "voices/en_US-lessac-medium.onnx");
    const script = new URL("./piper_worker.py", import.meta.url).pathname;
    this.proc = spawnTied(py, [script, voice], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stderr?.on("data", () => {});
    this.proc.on("exit", code => console.error(`[voice] piper worker exited (${code})`));
    const ready = new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input: this.proc!.stdout! });
      rl.on("line", line => {
        let msg: any; try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) return resolve();
        const cb = this.pending.get(msg.id); if (cb) { this.pending.delete(msg.id); cb(msg); }
      });
      this.proc!.on("exit", () => reject(new Error("piper worker exited")));
    });
    await ready;
    await this.synthesize("Ready.");
  }
  /** Returns 16 kHz mono s16le PCM. Requests are serialized. */
  synthesize(text: string): Promise<Buffer> {
    const run = async () => {
      const id = this.nextId++;
      const out = join(tmpdir(), `voice-tts-${process.pid}-${id}.pcm`);
      const reply: any = await new Promise(resolve => {
        this.pending.set(id, resolve);
        this.proc!.stdin!.write(JSON.stringify({ id, text, out }) + "\n");
      });
      if (!reply.ok) throw new Error(`piper: ${reply.error}`);
      const pcm = await readFile(out); await unlink(out).catch(() => {});
      return pcm;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }
  stop(): Promise<void> { return killChild(this.proc); }
}
