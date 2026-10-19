// Tolerant parser for the idea worker's model output. Accepts a bare array, or an object wrapping one
// (e.g. {"ideas":[...]} which format:"json" produces), with code fences / <think> blocks stripped.
import type { Branch } from "./expansion-jobs.js";

function firstJsonArray(s: string): unknown[] | undefined {
  for (let i = s.indexOf("["); i >= 0; i = s.indexOf("[", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        try { const v = JSON.parse(s.slice(i, j + 1)); if (Array.isArray(v)) return v; } catch { /* try next */ }
        break;
      }
    }
  }
  return undefined;
}

function arrayFrom(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) if (Array.isArray(v) && v.some(x => x && typeof x === "object")) return v;
  }
  return undefined;
}

export function parseBranches(raw: string): Branch[] {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .trim();

  let arr: unknown[] | undefined;
  try { arr = arrayFrom(JSON.parse(cleaned)); } catch { /* fall through */ }
  arr ??= firstJsonArray(cleaned);
  if (!arr) throw new Error("Model did not return a JSON array");
  if (arr.length !== 3) throw new Error("Expected exactly three branches");

  return arr.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("title" in item) || !("explanation" in item) ||
        typeof item.title !== "string" || typeof item.explanation !== "string") {
      throw new Error("Invalid branch structure");
    }
    const title = item.title.trim();
    const explanation = item.explanation.trim();
    if (!title || !explanation) throw new Error("Empty branch content");
    return { title: title.slice(0, 200), explanation: explanation.slice(0, 3000) };
  });
}
