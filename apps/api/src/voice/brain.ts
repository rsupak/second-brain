import { stripReasoning, capReply } from "./filters.js";
// Routes a transcript to the Second Brain: idea capture via POST /ideas, otherwise a short answer.
const CAPTURE_RE = /^\s*(?:(?:hey|ok|okay)[\s,]+)?(?:(?:bailey|baily|bailie|bailee|bayley|baylee|bailey's)[\s,.!]+)?(?:please[\s,]+)?(?:new idea|(?:capture|save|add|record) (?:an |a |a new |new |and (?:a )?new |and you )?idea)\b[\s:,.\-–—]*/i;

export function parseCapture(text: string): string | null {
  const m = CAPTURE_RE.exec(text);
  if (!m) return null;
  const content = text.slice(m[0].length).trim();
  return content.length ? content : null;
}

export function titleFrom(content: string): string {
  const words = content.replace(/[.!?]+$/, "").split(/\s+/).slice(0, 10).join(" ");
  const t = words.charAt(0).toUpperCase() + words.slice(1);
  return t.length > 200 ? t.slice(0, 197) + "..." : t;
}

export async function captureIdea(content: string): Promise<{ id: string; title: string }> {
  const api = process.env.VOICE_API_URL ?? "http://127.0.0.1:3333";
  const title = titleFrom(content);
  // No Origin header: server-to-server request passes the cross-site guard.
  const res = await fetch(api + "/ideas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, content })
  });
  if (res.status !== 201) throw new Error(`POST /ideas -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json() as any;
  return { id: String(body?.idea?.id ?? ""), title };
}

export async function createSkill(ideaId: string): Promise<{ status: number; body: any }> {
  const api = process.env.VOICE_API_URL ?? "http://127.0.0.1:3333";
  const res = await fetch(`${api}/ideas/${encodeURIComponent(ideaId)}/skill`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function postIdea(title: string, content: string): Promise<{ id: string; title: string }> {
  const api = process.env.VOICE_API_URL ?? "http://127.0.0.1:3333";
  const res = await fetch(api + "/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, content }) });
  if (res.status !== 201) throw new Error(`POST /ideas -> HTTP ${res.status}`);
  const body = await res.json() as any; return { id: String(body?.idea?.id ?? ""), title: String(body?.idea?.title ?? title) };
}
export async function createTopicSkill(topic: string, seed: string, sessionId: string | null): Promise<{ status: number; body: any }> {
  const api = process.env.VOICE_API_URL ?? "http://127.0.0.1:3333";
  const res = await fetch(api + "/skills/topic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic, seed, sessionId }) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const SYSTEM = "You are Bailey, Richard's local voice assistant. Answer in one to three short spoken sentences. " +
  "Plain text only: no markdown, lists, emoji or code. If you don't know, say so briefly. " +
  "You cannot save, capture or remember anything yourself; never claim you did.";

// qwen3:4b on this Mac is the thinking-only 2507 build: think:false and /no_think are ignored and it
// reasons in plain text. Voice answers therefore default to gemma4 (non-thinking, ~1 s), override with VOICE_MODEL.
export const VOICE_MODEL = process.env.VOICE_MODEL ?? "gemma4:e4b-it-qat";
const FALLBACK = "Sorry, I don't have a short answer for that.";

export async function answer(question: string): Promise<string> {
  const { generateResponse } = await import("../ai.js"); // lazy: opens the inference lock only when needed
  const raw = await generateResponse(
    [{ role: "system", content: SYSTEM }, { role: "user", content: question }],
    { model: VOICE_MODEL, think: false, temperature: 0.4, numPredict: 150, timeoutMs: 60_000 }
  );
  return cleanForSpeech(raw);
}

export function cleanForSpeech(s: string): string {
  const stripped = stripReasoning(s);
  return stripped ? capReply(stripped) || FALLBACK : FALLBACK;
}

export function splitSentences(s: string): string[] {
  return (s.match(/[^.!?]+[.!?]*/g) ?? [s]).map(x => x.trim()).filter(Boolean);
}
