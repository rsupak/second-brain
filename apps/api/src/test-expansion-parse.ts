// Unit tests for expansion-parse.ts (no DB, no model). Usage: npx tsx apps/api/src/test-expansion-parse.ts
import { parseBranches } from "./expansion-parse.js";
let pass = 0, fail = 0;
const check = (n: string, ok: boolean) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); };
const three = [1, 2, 3].map(i => ({ title: `T${i}`, explanation: `E${i}` }));
const ok = (raw: string) => { try { const b = parseBranches(raw); return b.length === 3 && b[2]!.title === "T3"; } catch { return false; } };
const err = (raw: string, msg: string) => { try { parseBranches(raw); return false; } catch (e) { return String(e).includes(msg); } };
check("bare array", ok(JSON.stringify(three)));
check('object wrapping {"ideas":[...]}', ok(JSON.stringify({ ideas: three })));
check("object with other key name", ok(JSON.stringify({ branches: three })));
check("code fences", ok("```json\n" + JSON.stringify(three) + "\n```"));
check("<think> tags with brackets inside", ok("<think>maybe [action] or [x]</think>\n" + JSON.stringify(three)));
check("prose + stray [action] before array", ok("Here: [action] then " + JSON.stringify(three) + " done"));
check("brackets inside strings", ok(JSON.stringify([{ title: "A [b]", explanation: "x]" }, three[1], { ...three[2] }])));
check("no array -> error", err("[action]", "did not return a JSON array"));
check("two items -> error", err(JSON.stringify(three.slice(0, 2)), "exactly three"));
check("bad structure -> error", err(JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]), "Invalid branch structure"));
check("empty title -> error", err(JSON.stringify([{ title: " ", explanation: "x" }, three[1], three[2]]), "Empty branch"));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
