// Source fetching, text extraction, chunking and storage for evidence-backed research.
// No model calls. No dependencies beyond Node built-ins and better-sqlite3.

import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const USER_AGENT = "SecondBrainResearch/0.1 (local, personal)";
const ACCEPTED_TYPES = ["text/html", "text/plain"];

export type FetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** TEST ONLY: allow loopback/private/link-local hosts. */
  allowPrivate?: boolean;
};

export type FetchResult = {
  url: string;
  final_url: string | null;
  title: string | null;
  content_type: string | null;
  http_status: number | null;
  content_hash: string | null;
  text: string | null;
  fetched_at: number;
  error: string | null;
};

// ---------- address safety ----------

export function isPrivateAddress(ip: string): boolean {
  let addr = ip.toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7); // IPv4-mapped
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
      (a === 169 && b === 254) ||             // link-local
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224;                               // multicast/reserved
  }
  return addr === "::" || addr === "::1" ||
    /^f[cd]/.test(addr) ||                    // fc00::/7 unique local
    /^fe[89ab]/.test(addr) ||                 // fe80::/10 link-local
    /^ff/.test(addr);                         // multicast
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Refused private host: ${host}`);
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`No addresses for ${host}`);
  const bad = addrs.find(a => isPrivateAddress(a.address));
  if (bad) throw new Error(`Refused private address ${bad.address} for host ${host}`);
}

// ---------- fetching ----------

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error(`Response too large: content-length ${declared} > ${maxBytes}`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, "") ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Never throws: failures are returned with `error` set so they can be recorded. */
export async function fetchSource(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 5, allowPrivate = false } = opts;
  const result: FetchResult = {
    url, final_url: null, title: null, content_type: null, http_status: null,
    content_hash: null, text: null, fetched_at: Date.now(), error: null
  };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error(`Unsupported protocol: ${current.protocol}`);
      }
      if (!allowPrivate) await assertPublicHost(current.hostname);
      const res = await fetch(current, {
        redirect: "manual", signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html, text/plain;q=0.9" }
      });
      result.http_status = res.status;
      result.final_url = current.toString();
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new Error(`Too many redirects (>${maxRedirects})`);
        current = new URL(res.headers.get("location")!, current);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      result.content_type = contentType || null;
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`HTTP ${res.status}`);
      }
      const mime = contentType.split(";")[0]!.trim().toLowerCase();
      if (!ACCEPTED_TYPES.includes(mime)) {
        await res.body?.cancel();
        throw new Error(`Unsupported content type: ${mime || "(none)"}`);
      }
      const raw = decode(await readCapped(res, maxBytes), contentType);
      const extracted = mime === "text/html" ? extractHtml(raw) : { title: null, text: normalizeText(raw) };
      if (!extracted.text) throw new Error("No readable text extracted");
      result.title = extracted.title;
      result.text = extracted.text;
      result.content_hash = sha256(extracted.text);
      return result;
    }
  } catch (e) {
    result.error = e instanceof Error ? `${e.name === "Error" ? "" : e.name + ": "}${e.message}` : String(e);
    return result;
  }
}

// ---------- extraction (built-in, no DOM) ----------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®",
  trade: "™", deg: "°", middot: "·", bull: "•", times: "×", minus: "−", plusmn: "±",
  micro: "µ", para: "¶", sect: "§", laquo: "«", raquo: "»", euro: "€", pound: "£"
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

export function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, "\n")
    .split("\n").map(l => l.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const DROP = ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside", "form", "iframe", "button"];

export function extractHtml(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? normalizeText(decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, ""))).replace(/\n/g, " ") || null : null;

  let s = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<head[\s\S]*?<\/head>/i, " ");
  for (const tag of DROP) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " "); // unclosed/self-closing
  }
  // Prefer the main content region when present.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(s) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(s);
  if (main) s = main[1]!;
  else s = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s)?.[1] ?? s;

  s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/?(p|div|section|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return { title, text: normalizeText(decodeEntities(s)) };
}

// ---------- chunking ----------

export type Chunk = { idx: number; text: string; start_char: number; end_char: number };

/** Chunks whose text === original.slice(start_char, end_char). Breaks at whitespace when possible. */
export function chunkText(text: string, { size = 1200, overlap = 200 }: { size?: number; overlap?: number } = {}): Chunk[] {
  if (overlap >= size) throw new Error("overlap must be smaller than size");
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const ws = text.lastIndexOf(" ", end) > text.lastIndexOf("\n", end)
        ? text.lastIndexOf(" ", end) : text.lastIndexOf("\n", end);
      if (ws > start + size / 2) end = ws;
    }
    chunks.push({ idx: chunks.length, text: text.slice(start, end), start_char: start, end_char: end });
    if (end >= text.length) break;
    let next = end - overlap;
    const ws = text.indexOf(" ", next);
    if (ws >= 0 && ws < end) next = ws + 1;
    start = Math.max(next, start + 1);
  }
  return chunks;
}

// ---------- quote verification ----------

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

export function verifyQuote(chunk: string, quote: string): boolean {
  const q = squash(quote);
  return q.length > 0 && squash(chunk).includes(q);
}

// ---------- storage ----------

export class SourceInUseError extends Error {
  constructor(sourceId: string) {
    super(`Source ${sourceId} content changed but findings reference its chunks; refusing to replace them`);
    this.name = "SourceInUseError";
  }
}

export function createResearchSourceStore(db: Database.Database) {
  const findSource = db.prepare(`SELECT id, content_hash FROM research_sources WHERE idea_id = ? AND url = ?`);
  const insertSource = db.prepare(`
    INSERT INTO research_sources (id, idea_id, url, final_url, title, content_type, http_status,
      content_hash, text, fetched_at, error)
    VALUES (@id, @idea_id, @url, @final_url, @title, @content_type, @http_status,
      @content_hash, @text, @fetched_at, @error)
  `);
  const updateSuccess = db.prepare(`
    UPDATE research_sources
    SET final_url = @final_url, title = @title, content_type = @content_type, http_status = @http_status,
        content_hash = @content_hash, text = @text, fetched_at = @fetched_at, error = NULL
    WHERE id = @id
  `);
  // A failed refetch records the error but keeps the last good text and chunks.
  const updateFailure = db.prepare(`
    UPDATE research_sources
    SET http_status = @http_status, fetched_at = @fetched_at, error = @error
    WHERE id = @id
  `);
  const countFindings = db.prepare(`
    SELECT COUNT(*) AS n FROM research_findings f
    JOIN research_chunks c ON c.id = f.chunk_id
    WHERE c.source_id = ?
  `);
  const deleteChunks = db.prepare(`DELETE FROM research_chunks WHERE source_id = ?`);
  const insertChunk = db.prepare(`
    INSERT INTO research_chunks (id, source_id, idx, text, start_char, end_char)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const saveTx = db.transaction((ideaId: string, r: FetchResult, chunks: Chunk[]) => {
    const existing = findSource.get(ideaId, r.url) as { id: string; content_hash: string | null } | undefined;
    const id = existing?.id ?? randomUUID();
    const params = { ...r, id, idea_id: ideaId };

    if (!existing) {
      insertSource.run(params);
    } else if (r.error) {
      updateFailure.run(params);
      return { id, chunks: "kept" as const };
    } else {
      if (existing.content_hash !== r.content_hash &&
          (countFindings.get(id) as { n: number }).n > 0) {
        throw new SourceInUseError(id);
      }
      updateSuccess.run(params);
      if (existing.content_hash === r.content_hash) return { id, chunks: "unchanged" as const };
    }
    if (r.error) return { id, chunks: "none" as const };

    deleteChunks.run(id); // this source only
    for (const c of chunks) insertChunk.run(randomUUID(), id, c.idx, c.text, c.start_char, c.end_char);
    return { id, chunks: "replaced" as const };
  });

  return {
    /** Upsert by (idea_id, url). Chunking happens before the transaction; no network inside it. */
    saveSource(ideaId: string, result: FetchResult, chunkOpts?: { size?: number; overlap?: number }) {
      const chunks = result.text && !result.error ? chunkText(result.text, chunkOpts) : [];
      return saveTx.immediate(ideaId, result, chunks);
    }
  };
}

export function saveSource(db: Database.Database, ideaId: string, result: FetchResult) {
  return createResearchSourceStore(db).saveSource(ideaId, result);
}
