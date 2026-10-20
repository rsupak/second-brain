// Pure helpers for the voice service: transcript noise filter, reasoning stripping, reply caps,
// pre-STT audio gate. No I/O, so they can be unit tested directly (test-voice-filters.ts).

// Whisper's common non-speech outputs on silence/noise (compared after normalisation).
const HALLUCINATIONS = new Set([
  "you", "thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching",
  "bye", "bye bye", "uh", "um", "hmm", "mm", "oh", "ah", "so", "okay", "ok", "the", "i", "a",
  "please subscribe", "subtitles by the amara org community", "silence", "blank audio", "music", "applause"
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** Returns the usable transcript, or null with a reason when it should be ignored (no reply). */
export function filterTranscript(raw: string): { text: string | null; reason?: string } {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return { text: null, reason: "empty" };
  // Strip bracketed / parenthesised / starred annotations: [Distant talking], (music), *sigh*, [BLANK_AUDIO]
  const text = collapsed.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ").replace(/\s+/g, " ").trim();
  if (!/[a-z0-9]/i.test(text)) return { text: null, reason: "annotation-only" };
  const n = norm(text);
  if (n.replace(/[^a-z0-9]/g, "").length < 3) return { text: null, reason: "too-short" };
  if (HALLUCINATIONS.has(n)) return { text: null, reason: "known-hallucination" };
  return { text };
}

const REASONING_START = /^\s*(okay|ok|alright|all right|hmm+|so|well|let me|let's|first|the user|i need to|i should|i think the user)\b[\s\S]{0,200}?\b(the user|user's|i need to|i should|let me|as bailey)\b/i;

/** Remove model reasoning. Returns "" if what remains is still reasoning (caller substitutes a fallback). */
export function stripReasoning(s: string): string {
  let t = (s ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = t.toLowerCase().lastIndexOf("</think>");
  if (close >= 0) t = t.slice(close + "</think>".length);   // unterminated/leading reasoning before a closing tag
  else if (/<think>/i.test(t)) t = t.slice(0, t.search(/<think>/i)); // reasoning that never closed
  t = t.replace(/<\/?think>/gi, "").trim();
  if (REASONING_START.test(t)) return "";
  return t;
}

/** Plain speakable text, at most `maxSentences` sentences and `maxChars` characters (cut on a word boundary). */
export function capReply(s: string, maxSentences = 3, maxChars = 300): string {
  let t = s.replace(/[*_#`>]+/g, "").replace(/\s+/g, " ").trim();
  const sentences = t.match(/[^.!?]+[.!?]*/g) ?? [t];
  t = sentences.slice(0, maxSentences).join(" ").replace(/\s+/g, " ").trim();
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[,;:\s]+$/, "") + ".";
  }
  return t;
}

/** Pre-STT gate on 16 kHz s16le PCM: enough total length and enough voiced (energetic) 30 ms windows. */
export function audioGate(pcm: Buffer, opts: { minMs?: number; minVoicedMs?: number; rmsThreshold?: number; sampleRate?: number } = {}):
  { ok: boolean; reason?: string; durationMs: number; voicedMs: number } {
  const rate = opts.sampleRate ?? 16000, minMs = opts.minMs ?? 300, minVoiced = opts.minVoicedMs ?? 240, thr = opts.rmsThreshold ?? 400;
  const samples = Math.floor(pcm.length / 2), durationMs = (samples / rate) * 1000;
  const win = Math.floor(rate * 0.03); let voiced = 0;
  for (let off = 0; off + win <= samples; off += win) {
    let s = 0; for (let i = 0; i < win; i++) { const v = pcm.readInt16LE((off + i) * 2); s += v * v; }
    if (Math.sqrt(s / win) > thr) voiced++;
  }
  const voicedMs = voiced * 30;
  if (durationMs < minMs) return { ok: false, reason: "too-short-audio", durationMs, voicedMs };
  if (voicedMs < minVoiced) return { ok: false, reason: "low-energy", durationMs, voicedMs };
  return { ok: true, durationMs, voicedMs };
}
