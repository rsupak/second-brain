// Tests the dashboard "Add idea" flow (POST /ideas with browser same-origin headers) via app.inject on a BRAIN_DB copy.
// Usage: sqlite3 data/brain.sqlite ".backup /tmp/brain-add.sqlite" && BRAIN_DB=/tmp/brain-add.sqlite SECOND_BRAIN_NO_LISTEN=1 npx tsx apps/api/src/test-add-idea.ts
import Database from "better-sqlite3";
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) {
  console.error("Refusing: set BRAIN_DB to an existing copy (not ./data/brain.sqlite)"); process.exit(2);
}
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }
delete process.env.AUTO_EVALUATE; delete process.env.AUTO_RESEARCH;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)); }
}
const { app } = await import("./server.js");
await app.ready();
const db = new Database(dbPath, { readonly: true });
const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
const browser = (origin: string, site: string) => ({ "content-type": "application/json", origin, "sec-fetch-site": site, "sec-fetch-mode": "cors" });
const body = JSON.stringify({ title: "Dashboard add test", content: "Added from the dashboard form test" });
const ideasBefore = n("SELECT COUNT(*) n FROM ideas");

for (const origin of ["http://127.0.0.1:3333", "http://localhost:3333"]) {
  const r = await app.inject({ method: "POST", url: "/ideas", headers: browser(origin, "same-origin"), payload: body });
  const b = r.json();
  check(`same-origin ${origin}: 201`, r.statusCode === 201, r.body);
  check(`same-origin ${origin}: idea + jobId + evaluationJobId + researchJobId`, typeof b.idea?.id === "string" && typeof b.jobId === "string" && typeof b.evaluationJobId === "string" && typeof b.researchJobId === "string", b);
  check(`same-origin ${origin}: idea row exists`, n("SELECT COUNT(*) n FROM ideas WHERE id = ?", b.idea?.id) === 1);
  check(`same-origin ${origin}: idea appears in GET /ideas`, (await app.inject({ method: "GET", url: "/ideas" })).json().some((i: any) => i.id === b.idea?.id));
}
const ideasMid = n("SELECT COUNT(*) n FROM ideas");
let r = await app.inject({ method: "POST", url: "/ideas", headers: browser("https://evil.example", "cross-site"), payload: body });
check("cross-site: 403", r.statusCode === 403, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: { ...browser("http://127.0.0.1:3333", "same-origin"), "content-type": "text/plain" }, payload: body });
check("text/plain body: 415", r.statusCode === 415, r.body);
r = await app.inject({ method: "POST", url: "/ideas", headers: browser("http://127.0.0.1:3333", "same-origin"), payload: JSON.stringify({ title: " ", content: "x" }) });
check("blank title: 400", r.statusCode === 400, r.body);
check("refused requests created nothing", n("SELECT COUNT(*) n FROM ideas") === ideasMid);
check("exactly 2 ideas added to the copy", ideasMid === ideasBefore + 2);
r = await app.inject({ method: "GET", url: "/dashboard/app.js" });
check("dashboard serves app.js with addIdeaForm", r.statusCode === 200 && r.body.includes("function addIdeaForm") && r.body.includes('method: "POST"'));
await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
