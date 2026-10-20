// Static checks for the Skills palace UI as served by the API (app.inject on a BRAIN_DB copy; no browser).
// Usage: sqlite3 data/brain.sqlite ".backup /tmp/brain-ui.sqlite" && BRAIN_DB=/tmp/brain-ui.sqlite SECOND_BRAIN_NO_LISTEN=1 npx tsx apps/api/src/test-dashboard-skills.ts
import { realpathSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const dbPath = process.env.BRAIN_DB;
if (!dbPath || !existsSync(dbPath) || realpathSync(dbPath) === realpathSync(resolve("./data/brain.sqlite"))) { console.error("Refusing: set BRAIN_DB to a copy"); process.exit(2); }
if (process.env.SECOND_BRAIN_NO_LISTEN !== "1") { console.error("Refusing: set SECOND_BRAIN_NO_LISTEN=1"); process.exit(2); }
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, d?: unknown) => { if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, d ?? ""); } };
const { app } = await import("./server.js");
await app.ready();
const html = (await app.inject({ method: "GET", url: "/" })).body;
const js = (await app.inject({ method: "GET", url: "/dashboard/app.js" })).body;
const css = (await app.inject({ method: "GET", url: "/dashboard/styles.css" })).body;
check("index.html has Skills nav link", html.includes('href="#/skills"'));
check("no external scripts/styles/CDNs", !/(src|href)="https?:\/\//.test(html) && !/@import|https?:\/\/[^"'\s]*\.(js|css)/.test(js + css));
for (const f of ["function skills(", "function skillDetail(", "function skillCard(", "function addIdeaForm(", "function citeText("]) check(`app.js defines ${f}`, js.includes(f));
check("router handles #/skills and #/skill/<id>@<version>", js.includes('h === "#/skills"') && js.includes('h.startsWith("#/skill/")') && js.includes('split("@")'));
check("uses the skills API routes", ["/skills/${encodeURIComponent(id)}/refresh", "/ideas/${encodeURIComponent(ideaId)}/skill", "/skills${skillQuery"].every(s => js.includes(s)));
check("never uses innerHTML/eval", !/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(js));
check("synthesis vs verified labels present", js.includes('"synthesis"') && js.includes("verified facts") && css.includes(".kind.synthesis"));
check("GET /skills 200 on the copy", (await app.inject({ method: "GET", url: "/skills" })).statusCode === 200);
await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
