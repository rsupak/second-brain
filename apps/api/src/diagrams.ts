// Skill diagrams: gemma4 returns a small JSON structure (nodes/edges or participants/messages) built only from the
// verified facts and the synthesis; Mermaid text is generated HERE from sanitized labels, then re-checked by a strict
// allowlist validator. Invalid diagrams are dropped. 0-2 diagrams per skill. Diagrams are labelled synthesis.
import { z } from "zod";
import { extractJsonObject, SYNTH_MODEL, type ResearchDeps } from "./research.js";

export const DIAGRAM_LIMITS = { maxDiagrams: 2, maxNodes: 15, maxEdges: 25, maxMessages: 15, maxLabel: 80, minFacts: 3 };
export type Diagram = { title: string; type: "flowchart" | "sequence"; mermaid: string; refs: number[] };

/** Label allowlist: letters, digits, spaces and basic punctuation. Removes quotes, backticks, <>, {}, |, ;, # outside [F#], and newlines. */
export function sanitizeLabel(s: string, max = DIAGRAM_LIMITS.maxLabel): string {
  const keepRefs = s.replace(/\[\s*F\s*(\d+)\s*\]/gi, "\u0001$1\u0002");
  const cleaned = keepRefs.replace(/[^\p{L}\p{N} .,:!?'()\/+&\-\u0001\u0002]/gu, " ").replace(/'/g, "’").replace(/\s+/g, " ").trim();
  let out = cleaned.replace(/\u0001(\d+)\u0002/g, "[F$1]").replace(/[\u0001\u0002]/g, "");
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return out;
}

const ID = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
/** Characters allowed inside labels (what sanitizeLabel can produce). [ ] only as part of [F#]. */
const LABEL_OK = (lab: string, max: number) => lab.length <= max + 1 && /^[\p{L}\p{N} .,:!?’()\/+&\-…]*$/u.test(lab.replace(/\[F\d+\]/g, ""));
const FORBIDDEN = /\b(click|call|href|style|classDef|class|linkStyle|javascript|init|themeVariables|securityLevel)\b|%%|<|>|`|\{|\}|&#|\\/i;

/**
 * Strict allowlist validator for the Mermaid we generate. Accepts only:
 *   flowchart TD|LR  /  graph TD|LR, then lines `ID["label"]`, `ID --> ID`, `ID -->|"label"| ID`;
 *   sequenceDiagram, then `participant ID as label` and `ID->>ID: label`.
 * Rejects click/href/style/class/init directives, HTML, braces and anything else.
 */
export function validateMermaid(text: string, limits = DIAGRAM_LIMITS): { ok: true } | { ok: false; error: string } {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: "empty" };
  const head = lines[0]!;
  const nodes = new Set<string>(); let edges = 0;
  if (/^(flowchart|graph) (TD|LR)$/.test(head)) {
    for (const l of lines.slice(1)) {
      let m: RegExpExecArray | null;
      const labelOk = (lab: string) => LABEL_OK(lab, limits.maxLabel);
      if ((m = /^([A-Za-z][A-Za-z0-9_]{0,30})\["([^"]*)"\]$/.exec(l))) {
        if (!labelOk(m[2]!)) return { ok: false, error: `bad node label: ${l}` };
        nodes.add(m[1]!);
      } else if ((m = /^([A-Za-z][A-Za-z0-9_]{0,30}) -->(?:\|"([^"]*)"\|)? ([A-Za-z][A-Za-z0-9_]{0,30})$/.exec(l))) {
        if (m[2] !== undefined && !labelOk(m[2])) return { ok: false, error: `bad edge label: ${l}` };
        if (!nodes.has(m[1]!) || !nodes.has(m[3]!)) return { ok: false, error: `edge to undeclared node: ${l}` };
        edges++;
      } else return { ok: false, error: `line not allowed: ${l.slice(0, 80)}` };
      if (FORBIDDEN.test(l.replace(/\["[^"]*"\]|\|"[^"]*"\|/g, "").replace(/-->/g, " "))) return { ok: false, error: `forbidden token: ${l}` };
    }
    if (nodes.size < 2 || nodes.size > limits.maxNodes) return { ok: false, error: `node count ${nodes.size}` };
    if (edges < 1 || edges > limits.maxEdges) return { ok: false, error: `edge count ${edges}` };
    return { ok: true };
  }
  if (head === "sequenceDiagram") {
    let msgs = 0;
    for (const l of lines.slice(1)) {
      let m: RegExpExecArray | null;
      if ((m = /^participant ([A-Za-z][A-Za-z0-9_]{0,30}) as ([^\n]+)$/.exec(l))) {
        if (!LABEL_OK(m[2]!, limits.maxLabel) || m[2]!.includes(":")) return { ok: false, error: `bad participant: ${l}` };
        nodes.add(m[1]!);
      } else if ((m = /^([A-Za-z][A-Za-z0-9_]{0,30})->>([A-Za-z][A-Za-z0-9_]{0,30}): ([^\n]+)$/.exec(l))) {
        if (!nodes.has(m[1]!) || !nodes.has(m[2]!)) return { ok: false, error: `message to undeclared participant: ${l}` };
        if (!LABEL_OK(m[3]!, limits.maxLabel)) return { ok: false, error: `bad message: ${l}` };
        msgs++;
      } else return { ok: false, error: `line not allowed: ${l.slice(0, 80)}` };
    }
    if (nodes.size < 2 || nodes.size > limits.maxNodes || msgs < 1 || msgs > limits.maxMessages) return { ok: false, error: "participant/message count" };
    return { ok: true };
  }
  return { ok: false, error: `unsupported diagram type: ${head.slice(0, 40)}` };
}

const DiagramSpec = z.object({
  title: z.string().trim().min(1).max(120),
  type: z.enum(["flowchart", "sequence"]),
  direction: z.enum(["TD", "LR"]).optional().default("TD"),
  nodes: z.array(z.object({ id: z.string(), label: z.string() })).optional().default([]),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional().default("") })).optional().default([]),
  participants: z.array(z.object({ id: z.string(), label: z.string() })).optional().default([]),
  messages: z.array(z.object({ from: z.string(), to: z.string(), text: z.string() })).optional().default([])
});
const DiagramsSchema = z.object({ diagrams: z.array(z.unknown()).max(4) });
export type DiagramSpecT = z.infer<typeof DiagramSpec>;

/** Strips [F#] refs that do not exist; returns label and referenced fact numbers. */
function refsIn(label: string, factCount: number) {
  const refs: number[] = [];
  const out = label.replace(/\[F(\d+)\]/g, (m, d) => { const n = Number(d); if (n >= 1 && n <= factCount) { refs.push(n); return m; } return ""; }).replace(/\s+/g, " ").trim();
  return { out, refs };
}

/** Builds Mermaid text from a spec with sanitized ids/labels. Returns null if the spec is unusable. */
export function specToMermaid(raw: unknown, factCount: number): { diagram: Diagram } | { error: string } {
  const p = DiagramSpec.safeParse(raw);
  if (!p.success) return { error: "spec schema" };
  const s = p.data; const refs = new Set<number>();
  const idMap = new Map<string, string>();
  const nid = (x: string) => { if (!idMap.has(x)) idMap.set(x, `n${idMap.size + 1}`); return idMap.get(x)!; };
  const lab = (x: string) => { const r = refsIn(sanitizeLabel(x), factCount); r.refs.forEach(n => refs.add(n)); return r.out; };
  let text: string;
  if (s.type === "flowchart") {
    if (s.nodes.length < 2 || s.nodes.length > DIAGRAM_LIMITS.maxNodes) return { error: `node count ${s.nodes.length}` };
    const lines = [`flowchart ${s.direction}`];
    for (const n of s.nodes) { const l = lab(n.label); if (!l) return { error: "empty node label" }; lines.push(`${nid(n.id)}["${l}"]`); }
    const known = new Set(s.nodes.map(n => n.id));
    for (const e of s.edges.slice(0, DIAGRAM_LIMITS.maxEdges)) {
      if (!known.has(e.from) || !known.has(e.to)) continue;   // drop edges to unknown nodes
      const l = e.label ? lab(e.label) : "";
      lines.push(l ? `${nid(e.from)} -->|"${l}"| ${nid(e.to)}` : `${nid(e.from)} --> ${nid(e.to)}`);
    }
    text = lines.join("\n");
  } else {
    if (s.participants.length < 2 || s.participants.length > DIAGRAM_LIMITS.maxNodes) return { error: "participant count" };
    const lines = ["sequenceDiagram"];
    for (const pt of s.participants) { const l = lab(pt.label).replace(/[:]/g, " "); if (!l) return { error: "empty participant" }; lines.push(`participant ${nid(pt.id)} as ${l}`); }
    const known = new Set(s.participants.map(x => x.id));
    for (const m of s.messages.slice(0, DIAGRAM_LIMITS.maxMessages)) {
      if (!known.has(m.from) || !known.has(m.to)) continue;
      const l = lab(m.text); if (l) lines.push(`${nid(m.from)}->>${nid(m.to)}: ${l}`);
    }
    text = lines.join("\n");
  }
  const v = validateMermaid(text);
  if (!v.ok) return { error: v.error };
  return { diagram: { title: sanitizeLabel(s.title, 120), type: s.type, mermaid: text, refs: [...refs].sort((a, b) => a - b) } };
}

export function diagramPrompt(ideaTitle: string, facts: Array<{ n: number; claim: string }>, synthesis: string, related: string[]) {
  const system = `You draw 0 to 2 small diagrams that connect ideas for a study guide.
Use ONLY the VERIFIED FACTS, the SYNTHESIS text and the RELATED IDEAS given. Do not add facts.
Every node, edge or message that states a fact must include its fact reference like [F3]. Structural labels (the idea name, a step name) need no reference.
Good choices: a "flowchart" of how it works, a concept map (flowchart) linking key facts to the idea and related ideas, or a "sequence" diagram for a process between actors.
At most 12 nodes per diagram, labels under 60 characters, plain words only (no quotes, brackets other than [F#], code or HTML).
If a diagram would not be meaningful, return {"diagrams": []}.
Return ONLY JSON: {"diagrams": [{"title": "...", "type": "flowchart", "direction": "TD"|"LR", "nodes": [{"id": "a", "label": "..."}], "edges": [{"from": "a", "to": "b", "label": "..."}]}
  or {"title": "...", "type": "sequence", "participants": [{"id": "u", "label": "User"}], "messages": [{"from": "u", "to": "a", "text": "..."}]}]}`;
  const user = `IDEA: ${ideaTitle}\n\nVERIFIED FACTS:\n${facts.map(f => `[F${f.n}] ${f.claim}`).join("\n")}\n\nSYNTHESIS:\n${synthesis}\n\nRELATED IDEAS:\n${related.join("\n") || "(none)"}`;
  return { system, user };
}

export async function generateDiagrams(ideaTitle: string, facts: Array<{ n: number; claim: string }>, synthesis: string, related: string[],
  deps: Pick<ResearchDeps, "llm" | "log">) {
  if (facts.length < DIAGRAM_LIMITS.minFacts) return { diagrams: [] as Diagram[], dropped: [] as string[], skipped: `fewer than ${DIAGRAM_LIMITS.minFacts} facts` };
  const { system, user } = diagramPrompt(ideaTitle, facts, synthesis, related);
  let raw: string;
  try {
    raw = await deps.llm([{ role: "system", content: system }, { role: "user", content: user }],
      { format: "json", temperature: 0.2, numPredict: 1600, numCtx: 8192, model: SYNTH_MODEL });
  } catch (e) { deps.log?.(`diagram generation failed: ${String(e).slice(0, 160)}`); return { diagrams: [], dropped: [], skipped: "model error" }; }
  const parsed = DiagramsSchema.safeParse((() => { try { return extractJsonObject(raw); } catch { return null; } })());
  if (!parsed.success) return { diagrams: [], dropped: ["invalid JSON"], skipped: null };
  const diagrams: Diagram[] = []; const dropped: string[] = [];
  for (const d of parsed.data.diagrams) {
    if (diagrams.length >= DIAGRAM_LIMITS.maxDiagrams) { dropped.push("over limit"); continue; }
    const r = specToMermaid(d, facts.length);
    if ("error" in r) { dropped.push(r.error); deps.log?.(`diagram dropped: ${r.error}`); } else diagrams.push(r.diagram);
  }
  return { diagrams, dropped, skipped: diagrams.length ? null : "model returned none usable" };
}
