// Research source fetching/extraction/storage test.
// Runs ONLY against a copy of the database given by BRAIN_DB. No model calls.
// Usage: BRAIN_DB=/tmp/brain-test.sqlite npx tsx apps/api/src/test-research-sources.ts

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ensureResearchTables, researchState } from "./research-schema.js";
import {
  chunkText, createResearchSourceStore, fetchSource, isPrivateAddress, sha256, verifyQuote, SourceInUseError
} from "./research-sources.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath) throw new Error("Set BRAIN_DB to a test copy of the database.");
if (path.resolve(dbPath) === path.resolve("./data/brain.sqlite")) {
  throw new Error("Refusing to run against the real database.");
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

let failures = 0, total = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  total++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

const LONG = Array.from({ length: 60 }, (_, i) =>
  `Sentence ${i} about LoRa spreading factor and link budget measurements.`).join(" ");
const HTML = `<!doctype html><html><head><title>LoRa &amp; Mesh &#8211; Notes</title>
<style>.x{color:red}</style><script>var secret="SCRIPT_TEXT";</script></head>
<body><nav>NAV_TEXT</nav><header>HEADER_TEXT</header>
<main><h1>Field&nbsp;Results</h1><p>The radio reached 2&#x2009;km in tests.</p>
<!-- COMMENT_TEXT --><p>${LONG}</p><script>alert("INLINE_SCRIPT")</script></main>
<aside>ASIDE_TEXT</aside><footer>FOOTER_TEXT</footer></body></html>`;

const server = createServer((req, res) => {
  const u = req.url ?? "/";
  if (u === "/page") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(HTML); }
  else if (u === "/plain") { res.writeHead(200, { "content-type": "text/plain" }); res.end("Plain   text\r\n\r\n\r\nsecond line"); }
  else if (u === "/big") { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(3 * 1024 * 1024)); }
  else if (u === "/big-chunked") {   // no content-length: exercises the streaming cap
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    let n = 0; const iv = setInterval(() => { res.write("y".repeat(64 * 1024)); if (++n >= 50) { clearInterval(iv); res.end(); } }, 1);
    res.on("close", () => clearInterval(iv));
  }
  else if (u === "/redirect") { res.writeHead(302, { location: "/page" }); res.end(); }
  else if (u === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
  else if (u === "/binary") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.from([0, 1, 2, 3])); }
  else { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); }
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const T = { allowPrivate: true };

const ideaId = `research-test-idea-${randomUUID()}`;
try {
  // Migration idempotency
  ensureResearchTables(db);
  const s1 = researchState(db);
  ensureResearchTables(db);
  const s2 = researchState(db);
  check("migration idempotent (3 tables, unchanged)", Object.keys(s2).length === 3 && JSON.stringify(s1) === JSON.stringify(s2), s2);

  const fks = db.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list('research_findings')`).all() as any[];
  check("FK research_findings.idea_id -> ideas(id) exists", fks.some(f => f.table === "ideas" && f.from === "idea_id" && f.to === "id"), fks);
  check("FK research_findings.chunk_id -> research_chunks(id) exists", fks.some(f => f.table === "research_chunks" && f.from === "chunk_id"), fks);

  db.prepare(`INSERT INTO ideas (id, title, content, origin, depth) VALUES (?, '[TEST] Research', 'Temporary test row.', 'user', 0)`).run(ideaId);

  // Extraction
  const page = await fetchSource(`${base}/page`, T);
  check("html fetch ok", page.error === null && page.http_status === 200, page.error);
  check("title extracted + entities decoded", page.title === "LoRa & Mesh – Notes", page.title);
  const t = page.text ?? "";
  check("scripts/styles/comments stripped", !/SCRIPT_TEXT|INLINE_SCRIPT|color:red|COMMENT_TEXT/.test(t));
  check("nav/header/footer/aside stripped", !/NAV_TEXT|HEADER_TEXT|FOOTER_TEXT|ASIDE_TEXT/.test(t));
  check("main text kept, entities decoded", t.includes("Field Results") && t.includes("The radio reached 2\u2009km in tests."), t.slice(0, 80));
  const again = await fetchSource(`${base}/page`, T);
  check("hash stable and = sha256(text)", page.content_hash === again.content_hash && page.content_hash === sha256(t));

  const plain = await fetchSource(`${base}/plain`, T);
  check("text/plain accepted + whitespace normalized", plain.text === "Plain text\n\nsecond line", plain.text);

  const red = await fetchSource(`${base}/redirect`, T);
  check("redirect followed, final_url recorded", red.error === null && red.final_url === `${base}/page`, red.final_url);
  const loop = await fetchSource(`${base}/loop`, T);
  check("redirect loop capped", /Too many redirects/.test(loop.error ?? ""), loop.error);

  const big = await fetchSource(`${base}/big`, T);
  check("oversize (content-length) rejected", /too large/.test(big.error ?? "") && big.text === null, big.error);
  const bigc = await fetchSource(`${base}/big-chunked`, T);
  check("oversize (streamed) rejected at cap", /exceeded/.test(bigc.error ?? "") && bigc.text === null, bigc.error);
  const bin = await fetchSource(`${base}/binary`, T);
  check("binary content type rejected", /Unsupported content type/.test(bin.error ?? ""), bin.error);
  const nf = await fetchSource(`${base}/missing`, T);
  check("404 returns error + status", nf.http_status === 404 && nf.error === "HTTP 404", nf.error);

  // Private host refusal
  const priv = await fetchSource(`${base}/page`);
  check("loopback refused without allowPrivate", /Refused private/.test(priv.error ?? ""), priv.error);
  const lh = await fetchSource(`http://localhost:1/`);
  check("localhost refused", /Refused private/.test(lh.error ?? ""), lh.error);
  check("private ranges detected",
    ["10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"].every(isPrivateAddress) &&
    !["8.8.8.8", "1.1.1.1", "2606:4700::1111"].some(isPrivateAddress));
  const ftp = await fetchSource("ftp://example.com/x");
  check("non-http protocol refused", /Unsupported protocol/.test(ftp.error ?? ""), ftp.error);

  // Chunking
  const chunks = chunkText(t, { size: 1200, overlap: 200 });
  check("chunk offsets slice original exactly", chunks.length > 1 && chunks.every(c => t.slice(c.start_char, c.end_char) === c.text), chunks.length);
  check("chunks cover whole text with overlap",
    chunks[0]!.start_char === 0 && chunks.at(-1)!.end_char === t.length &&
    chunks.slice(1).every((c, i) => c.start_char < chunks[i]!.end_char && c.start_char > chunks[i]!.start_char));
  check("chunks within size", chunks.every(c => c.text.length <= 1200));

  // Storage
  const store = createResearchSourceStore(db);
  const countSrc = () => (db.prepare(`SELECT COUNT(*) AS n FROM research_sources WHERE idea_id = ?`).get(ideaId) as { n: number }).n;
  const chunkIds = (id: string) => (db.prepare(`SELECT id FROM research_chunks WHERE source_id = ? ORDER BY idx`).all(id) as { id: string }[]).map(r => r.id);

  const a = store.saveSource(ideaId, page);
  const other = store.saveSource(ideaId, plain);
  const firstChunks = chunkIds(a.id);
  check("first save inserts chunks", a.chunks === "replaced" && firstChunks.length > 1, a);
  const a2 = store.saveSource(ideaId, again);
  check("re-save same url: no duplicate, same id", countSrc() === 2 && a2.id === a.id);
  check("same hash keeps chunks", a2.chunks === "unchanged" && JSON.stringify(chunkIds(a.id)) === JSON.stringify(firstChunks));

  const changed = { ...page, text: page.text + "\nUpdated paragraph.", content_hash: sha256(page.text + "\nUpdated paragraph.") };
  const a3 = store.saveSource(ideaId, changed);
  const newChunks = chunkIds(a.id);
  check("changed content replaces chunks for that source", a3.chunks === "replaced" && newChunks.every(id => !firstChunks.includes(id)));
  check("other source's chunks untouched", chunkIds(other.id).length === 1);

  const failed = { ...page, error: "HTTP 503", http_status: 503, text: null, content_hash: null };
  store.saveSource(ideaId, failed);
  const row = db.prepare(`SELECT error, http_status, text IS NOT NULL AS has_text FROM research_sources WHERE id = ?`).get(a.id) as any;
  check("failed refetch records error, keeps last good text/chunks", row.error === "HTTP 503" && row.has_text === 1 && chunkIds(a.id).length === newChunks.length, row);

  const nfSaved = store.saveSource(ideaId, nf);
  const nfRow = db.prepare(`SELECT error, http_status FROM research_sources WHERE id = ?`).get(nfSaved.id) as any;
  check("404 source recorded with error", nfRow.error === "HTTP 404" && nfRow.http_status === 404 && chunkIds(nfSaved.id).length === 0, nfRow);

  // Findings protect chunks from silent replacement
  db.prepare(`INSERT INTO research_findings (id, idea_id, claim, quote, chunk_id, verified, created_at) VALUES (?, ?, 'c', 'q', ?, 0, ?)`)
    .run(randomUUID(), ideaId, newChunks[0], Date.now());
  let inUse: unknown;
  try { store.saveSource(ideaId, page); } catch (e) { inUse = e; }
  check("content change refused when findings reference chunks", inUse instanceof SourceInUseError && JSON.stringify(chunkIds(a.id)) === JSON.stringify(newChunks));

  // FK enforcement (foreign_keys = ON on this connection)
  let fkErr: unknown;
  try {
    db.prepare(`INSERT INTO research_findings (id, idea_id, claim, quote, chunk_id, verified, created_at) VALUES (?, ?, 'c', 'q', ?, 0, ?)`)
      .run(randomUUID(), `no-such-idea-${randomUUID()}`, newChunks[0], Date.now());
  } catch (e) { fkErr = e; }
  check("finding for nonexistent idea rejected by FK", /FOREIGN KEY constraint failed/.test(String(fkErr)), String(fkErr));

  // verifyQuote
  const c0 = chunks[0]!.text;
  check("verifyQuote exact match", verifyQuote(c0, "The radio reached 2\u2009km in tests."));
  check("verifyQuote tolerates whitespace differences", verifyQuote("alpha   beta\n\ngamma", "alpha beta  gamma"));
  check("verifyQuote rejects altered quote", !verifyQuote(c0, "The radio reached 5 km in tests."));
  check("verifyQuote rejects empty quote", !verifyQuote(c0, "   "));

  // Optional live fetch (not counted)
  const live = await fetchSource("https://en.wikipedia.org/wiki/LoRa");
  if (live.error) console.log(`SKIP  [optional live] Wikipedia LoRa fetch: ${live.error}`);
  else console.log(`INFO  [optional live] Wikipedia LoRa: status ${live.http_status}, title ${JSON.stringify(live.title)}, ${live.text!.length} chars, ${chunkText(live.text!).length} chunks, starts ${JSON.stringify(live.text!.slice(0, 120))}`);
} finally {
  // Remove only this test's rows from the COPY.
  db.prepare(`DELETE FROM research_findings WHERE idea_id = ?`).run(ideaId);
  db.prepare(`DELETE FROM research_chunks WHERE source_id IN (SELECT id FROM research_sources WHERE idea_id = ?)`).run(ideaId);
  db.prepare(`DELETE FROM research_sources WHERE idea_id = ?`).run(ideaId);
  db.prepare(`DELETE FROM ideas WHERE id = ?`).run(ideaId);
  server.close();
  db.close();
}

console.log(`\n${total - failures}/${total} passed`);
process.exit(failures ? 1 : 0);
