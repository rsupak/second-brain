// Tests the cross-site guard via app.inject on a BRAIN_DB copy. Refuses the real DB.
// Usage: sqlite3 data/brain.sqlite ".backup /tmp/brain-sec.sqlite" && BRAIN_DB=/tmp/brain-sec.sqlite SECOND_BRAIN_NO_LISTEN=1 npx tsx apps/api/src/test-security.ts
import Database from "better-sqlite3";
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { checkRequest } from "./security.js";

const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) {
  console.error("Refusing: set BRAIN_DB to an existing copy (not ./data/brain.sqlite)"); process.exit(2);
}
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}

const { app } = await import("./server.js");
await app.ready();
const db = new Database(dbPath, { readonly: true });
const ideaCount = () => (db.prepare("SELECT COUNT(*) n FROM ideas").get() as { n: number }).n;
const json = { "content-type": "application/json" };
const idea = JSON.stringify({ title: "sec test", content: "guard test idea" });

// Unit checks
check("unit: GET always ok", checkRequest("GET", { origin: "http://evil.example", "sec-fetch-site": "cross-site" }).ok);
check("unit: cross-site POST refused", !checkRequest("POST", { "sec-fetch-site": "cross-site" }).ok);
check("unit: foreign origin refused", !checkRequest("POST", { origin: "http://evil.example" }).ok);
check("unit: no origin ok", checkRequest("POST", {}).ok);

// GETs
for (const url of ["/health", "/ideas", "/evaluations", "/evaluations/status", "/memories"]) {
  const r = await app.inject({ method: "GET", url, headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" } });
  check(`GET ${url} 200 even with foreign origin`, r.statusCode === 200, r.statusCode);
}

// Cross-site POSTs refused, no side effects
let before = ideaCount();
let r = await app.inject({ method: "POST", url: "/ideas", headers: { ...json, origin: "http://evil.example" }, payload: idea });
check("POST /ideas foreign Origin -> 403", r.statusCode === 403, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: { ...json, "sec-fetch-site": "cross-site" }, payload: idea });
check("POST /ideas Sec-Fetch-Site cross-site -> 403", r.statusCode === 403, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: { "content-type": "text/plain" }, payload: idea });
check("POST /ideas text/plain -> 415", r.statusCode === 415, r.body);
r = await app.inject({ method: "POST", url: "/evaluations/queue", headers: { origin: "null" } });
check("POST /evaluations/queue Origin null -> 403", r.statusCode === 403, r.body);
check("refused POSTs created no ideas", ideaCount() === before, { before, after: ideaCount() });

// Allowed POSTs still work
r = await app.inject({ method: "POST", url: "/ideas", headers: json, payload: idea });
check("POST /ideas no Origin -> 201", r.statusCode === 201, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: { ...json, origin: "http://127.0.0.1:3333", "sec-fetch-site": "same-origin" }, payload: idea });
check("POST /ideas same-origin -> 201", r.statusCode === 201, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: { ...json, origin: "http://localhost:3333" }, payload: JSON.stringify({ title: "" }) });
check("POST /ideas invalid body still -> 400", r.statusCode === 400, r.body);
check("allowed POSTs created 2 ideas", ideaCount() === before + 2, { before, after: ideaCount() });
r = await app.inject({ method: "POST", url: "/evaluations/queue" });
check("POST /evaluations/queue no Origin -> 200", r.statusCode === 200, r.body);

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
