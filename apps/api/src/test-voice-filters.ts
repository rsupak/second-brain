// Unit tests for voice/filters.ts and brain.cleanForSpeech (no services needed).
import { filterTranscript, stripReasoning, capReply, audioGate } from "./voice/filters.js";
import { cleanForSpeech } from "./voice/brain.js";
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); };

for (const n of ["[Distant talking]", "(music)", "[BLANK_AUDIO]", " [ Silence ] ", "*sigh*", "♪♪", "Thank you.", "you", "You.", "", "  ", "Uh.", "ok", "Thanks for watching!", "[Distant talking] (music)"])
  check(`noise ignored: ${JSON.stringify(n)}`, filterTranscript(n).text === null, String(filterTranscript(n).reason));
for (const [inp, out] of [["What is the boiling point of water?", "What is the boiling point of water?"], ["Testing.", "Testing."],
  ["[Distant talking] What time is it?", "What time is it?"], ["Thank you for the reminder about the dentist.", "Thank you for the reminder about the dentist."]])
  check(`speech kept: ${JSON.stringify(inp)}`, filterTranscript(inp).text === out, String(filterTranscript(inp).text));

check("think block stripped", stripReasoning("<think>\nlong reasoning\n</think>\n\nWater boils at 212 degrees.") === "Water boils at 212 degrees.");
check("leading reasoning before </think> stripped", stripReasoning("Okay, the user asks... I should say 212.\n</think>\n\nWater boils at 212 degrees Fahrenheit.") === "Water boils at 212 degrees Fahrenheit.");
const live = 'Okay, the user mentioned "[Distant talking] /nothink". I need to respond as Bailey, Richard\'s local voice assistant. First, I should understand what this means.';
check("untagged reasoning (live log) rejected", stripReasoning(live) === "");
check("unclosed <think> dropped", stripReasoning("Sure.<think>hmm let me") === "Sure.");
check("normal answer untouched", stripReasoning("Water boils at 212 degrees Fahrenheit at sea level.") === "Water boils at 212 degrees Fahrenheit at sea level.");
check("'So' answer not mistaken for reasoning", stripReasoning("So far it is sunny today.") === "So far it is sunny today.");
check("cleanForSpeech: reasoning -> short fallback", cleanForSpeech(live) === "Sorry, I don't have a short answer for that.", cleanForSpeech(live));

const long = "One. Two is here. Three is here. Four should go. Five too.";
check("cap to 3 sentences", capReply(long) === "One. Two is here. Three is here.", capReply(long));
const huge = ("This is a fairly long sentence with many words in it, and it keeps going on and on without stopping " ).repeat(8);
const c = capReply(huge);
check("cap to <= 300 chars, ends cleanly", c.length <= 301 && /[.!?]$/.test(c), `len=${c.length}`);
check("markdown removed", capReply("**Hi** there `x`") === "Hi there x");

const silence = Buffer.alloc(16000 * 2 * 2);
const noise = Buffer.alloc(16000 * 2 * 2); for (let i = 0; i < noise.length / 2; i++) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 300), i * 2);
const tone = Buffer.alloc(16000 * 2); for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(Math.sin(i / 8) * 6000), i * 2);
check("gate: silence rejected", !audioGate(silence).ok, String(audioGate(silence).reason));
check("gate: quiet noise rejected", !audioGate(noise).ok, String(audioGate(noise).reason));
check("gate: 0.2 s blip rejected", !audioGate(tone.subarray(0, 6400)).ok, String(audioGate(tone.subarray(0, 6400)).reason));
check("gate: 1 s voiced audio accepted", audioGate(tone).ok, `voiced=${audioGate(tone).voicedMs}ms`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
