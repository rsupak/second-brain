// Second Brain dashboard. Vanilla JS; all untrusted text is inserted as text nodes (never parsed as HTML).
"use strict";

const app = document.getElementById("app");
let refreshTimer = null;

// ---------- helpers ----------
function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}
function safeLink(url, text) {
  // Only http(s) links are clickable; anything else is shown as plain text.
  let ok = false;
  try { ok = ["http:", "https:"].includes(new URL(url).protocol); } catch { ok = false; }
  return ok ? el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text || url) : el("span", {}, text || url);
}
function pill(status) { return el("span", { class: `pill ${status}` }, status); }
function fmtTime(v) {
  if (v == null || v === "") return "—";
  const d = typeof v === "number" ? new Date(v) : new Date(String(v).replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
  return isNaN(d) ? String(v) : d.toLocaleString();
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { ok: res.ok, status: res.status, body };
}
function render(...nodes) { app.replaceChildren(...nodes); }
function errorBox(msg) { return el("div", { class: "notice bad" }, msg); }
function parseList(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : [s]; } catch { return s ? [s] : []; } }
function score(e) { return e ? e.feasibility + e.relevance + e.novelty - e.cost : null; }

// ---------- views ----------
async function overview() {
  const r = await api("/status");
  if (!r.ok) return render(el("h2", {}, "Overview"), errorBox(`GET /status failed (${r.status})`));
  const s = r.body;
  const svc = (name, x) => el("div", { class: "card" }, el("h3", {}, name),
    el("div", {}, x.reachable ? pill("ok") : el("span", { class: "pill bad" }, "unreachable"), " ", el("span", { class: "muted small" }, `${x.url} · ${x.ms} ms`)),
    x.error ? el("div", { class: "small muted" }, x.error) : null);
  const lock = s.inferenceLock[0];
  const counts = (rows, key) => el("table", {}, el("tr", {}, ...(key ? [el("th", {}, "type")] : []), el("th", {}, "status"), el("th", {}, "count")),
    rows.map(x => el("tr", {}, ...(key ? [el("td", {}, x[key])] : []), el("td", {}, pill(x.status)), el("td", {}, x.count))));
  render(
    el("h2", {}, "Overview ", el("span", { class: "muted small" }, `auto-refresh 10s · ${new Date().toLocaleTimeString()}`)),
    el("div", { class: "grid" },
      svc("Ollama", s.ollama), svc("SearXNG", s.searxng),
      el("div", { class: "card" }, el("h3", {}, "Inference lock"),
        lock ? el("div", {}, lock.held ? el("span", { class: "pill warn" }, "held") : pill("ok"), " ",
          el("span", { class: "muted small" }, lock.held ? `owner ${lock.owner} until ${fmtTime(lock.lease_until)}` : "free"))
          : el("div", { class: "muted" }, "no lock row")),
      el("div", { class: "card" }, el("h3", {}, "Workers"),
        el("div", { class: "small muted" }, s.workers.note),
        s.workers.activeLeases.length ? s.workers.activeLeases.map(a => el("div", {}, `${a.queue}: ${a.count} running`)) : el("div", {}, "No running leases"),
        s.workers.lastCompleted.map(a => el("div", { class: "small" }, `${a.queue} last completed ${fmtTime(a.at)}`)))
    ),
    el("h3", {}, "jobs"), counts(s.jobs, "type"),
    el("h3", {}, "evaluation_jobs"), counts(s.evaluationJobs)
  );
  refreshTimer = setTimeout(() => { if (location.hash === "" || location.hash === "#/") overview(); }, 10000);
}

// Manual "Add idea" form. Same-origin POST /ideas with a JSON body (passes the cross-site guard).
let lastAddNotice = null;
function addIdeaForm() {
  const title = el("input", { type: "text", maxlength: 200, required: true, placeholder: "Title", class: "wide" });
  const content = el("textarea", { maxlength: 10000, required: true, rows: 4, placeholder: "Description", class: "wide" });
  const notice = el("div", {}, lastAddNotice);
  const submit = el("button", { type: "submit" }, "Add idea");
  const form = el("form", { class: "card add-idea", onsubmit: async (ev) => {
    ev.preventDefault();
    const t = title.value.trim(), c = content.value.trim();
    if (!t || !c) { notice.replaceChildren(el("div", { class: "notice bad" }, "Title and description are both required.")); return; }
    submit.disabled = true;
    try {
      const r = await api("/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t, content: c }) });
      if (r.status === 201 && r.body?.idea?.id) {
        const b = r.body, id = b.idea.id;
        const q = [["expansion", b.jobId], ["evaluation", b.evaluationJobId], ["research", b.researchJobId]]
          .map(([k, v]) => v ? `${k} (${v})` : v === null ? `${k} (queue failed)` : null).filter(Boolean);
        lastAddNotice = el("div", { class: "notice ok" }, "Idea added: ", el("a", { href: `#/idea/${encodeURIComponent(id)}` }, b.idea.title),
          `. Queued: ${q.length ? q.join(", ") : "nothing"}.`);
        title.value = ""; content.value = "";
        await ideas(); // refresh the list (form re-renders with the success notice)
      } else {
        const msg = r.body?.error ? `${r.body.error}` : "unknown error";
        notice.replaceChildren(el("div", { class: "notice bad" }, `Could not add idea (HTTP ${r.status}): ${msg}`));
      }
    } catch (e) { notice.replaceChildren(el("div", { class: "notice bad" }, `Could not add idea: ${e && e.message ? e.message : e}`)); }
    finally { submit.disabled = false; }
  } }, el("strong", {}, "Add idea"), title, content, el("div", {}, submit), notice);
  return el("details", { class: "add-wrap", open: lastAddNotice ? true : null }, el("summary", {}, "＋ Add idea"), form);
}

let ideaSort = { key: "score", dir: -1 };
async function ideas() {
  const [ir, er] = await Promise.all([api("/ideas"), api("/evaluations")]);
  if (!ir.ok) return render(el("h2", {}, "Ideas"), errorBox(`GET /ideas failed (${ir.status})`));
  const evals = new Map((er.ok ? er.body : []).map(e => [e.idea_id, e]));
  const rows = ir.body.map(i => ({ ...i, ev: evals.get(i.id) || null }));
  const val = (r, k) => k === "title" ? r.title.toLowerCase() : k === "depth" ? r.depth : k === "score" ? score(r.ev) : r.ev ? r.ev[k] : null;
  const draw = () => {
    const { key, dir } = ideaSort;
    rows.sort((a, b) => { const x = val(a, key), y = val(b, key); if (x == null) return 1; if (y == null) return -1; return x < y ? -dir : x > y ? dir : 0; });
    const th = (k, label) => el("th", { class: "sortable", onclick: () => { ideaSort = { key: k, dir: ideaSort.key === k ? -ideaSort.dir : (k === "title" ? 1 : -1) }; draw(); } },
      label, ideaSort.key === k ? (ideaSort.dir > 0 ? " ▲" : " ▼") : "");
    render(el("h2", {}, `Ideas (${rows.length})`), addIdeaForm(),
      el("table", {}, el("tr", {}, th("title", "Title"), th("depth", "Depth"), th("feasibility", "Feas."), th("cost", "Cost"), th("relevance", "Rel."), th("novelty", "Nov."), th("score", "Score")),
        rows.map(r => el("tr", {},
          el("td", {}, el("a", { href: `#/idea/${encodeURIComponent(r.id)}` }, r.title)),
          el("td", {}, r.depth),
          ...["feasibility", "cost", "relevance", "novelty"].map(k => el("td", {}, r.ev ? r.ev[k] : "—")),
          el("td", {}, r.ev ? score(r.ev) : "—")))),
      el("p", { class: "muted small" }, "Score = feasibility + relevance + novelty − cost (same ordering as /evaluations)."));
  };
  draw();
}

function treeView(nodes, rootId) {
  const kids = new Map();
  for (const n of nodes) { const k = n.parent_id || ""; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(n); }
  const build = (n) => el("li", {}, n.id === rootId ? el("strong", {}, n.title) : el("a", { href: `#/idea/${encodeURIComponent(n.id)}` }, n.title),
    el("span", { class: "muted small" }, ` · depth ${n.depth} · ${n.origin}`),
    (kids.get(n.id) || []).length ? el("ul", { class: "tree" }, kids.get(n.id).map(build)) : null);
  const root = nodes.find(n => n.id === rootId);
  return root ? el("ul", { class: "tree root" }, build(root)) : el("div", { class: "muted" }, "No tree");
}

async function ideaDetail(id) {
  const [tr, er, rr] = await Promise.all([api(`/ideas/${encodeURIComponent(id)}/tree`), api("/evaluations"), api(`/ideas/${encodeURIComponent(id)}/research`)]);
  if (tr.status === 404 || rr.status === 404) return render(errorBox("Idea not found"));
  if (!tr.ok) return render(errorBox(`GET /ideas/:id/tree failed (${tr.status})`));
  const idea = tr.body.find(n => n.id === id);
  const ev = (er.ok ? er.body : []).find(e => e.idea_id === id);
  const research = rr.ok ? rr.body : null;
  const notice = el("div", {});
  const btn = el("button", { onclick: async () => {
    btn.disabled = true;
    const r = await api(`/ideas/${encodeURIComponent(id)}/research`, { method: "POST" });
    if (r.status === 202) notice.replaceChildren(el("div", { class: "notice ok" }, `Research queued (job ${r.body.jobId}). The research worker must be running to process it.`));
    else if (r.status === 409) notice.replaceChildren(el("div", { class: "notice warn" }, `A research job is already active for this idea (${r.body?.activeJobId ?? "unknown"}).`));
    else notice.replaceChildren(el("div", { class: "notice bad" }, `Could not queue research (HTTP ${r.status}).`));
    btn.disabled = false;
  } }, "Run research");

  const job = research?.latestJob;
  render(
    el("p", {}, el("a", { href: "#/ideas" }, "← Ideas")),
    el("h2", {}, idea ? idea.title : id),
    el("div", { class: "card" }, el("div", {}, idea?.content ?? ""), el("div", { class: "muted small" }, `origin ${idea?.origin ?? "?"} · created ${fmtTime(idea?.created_at)}`)),
    el("h3", {}, "Evaluation"),
    ev ? el("div", { class: "card" },
      el("div", { class: "scores" }, ...["feasibility", "cost", "relevance", "novelty"].map(k => el("span", {}, `${k}: `, el("strong", {}, ev[k]))), el("span", {}, "score: ", el("strong", {}, score(ev)))),
      el("p", {}, ev.summary),
      ...[["Requirements", ev.requirements], ["Limitations", ev.limitations], ["Claims", ev.claims]].map(([t, v]) =>
        el("div", {}, el("strong", {}, t), el("ul", {}, parseList(v).map(x => el("li", {}, typeof x === "string" ? x : JSON.stringify(x)))))),
      el("div", { class: "muted small" }, `evaluated ${fmtTime(ev.evaluated_at)}`))
      : el("div", { class: "card muted" }, "Not evaluated"),
    el("h3", {}, "Idea tree"), el("div", { class: "card" }, treeView(tr.body, tr.body.some(n => n.id === id && !n.parent_id) ? id : (tr.body[0]?.id ?? id))),
    el("h3", {}, "Research"),
    el("div", { class: "card" },
      el("div", {}, "Latest job: ", job ? [pill(job.status), ` attempts ${job.attempts} · created ${fmtTime(job.created_at)} · completed ${fmtTime(job.completed_at)}`] : el("span", { class: "muted" }, "none")),
      job?.error ? el("div", { class: "small", style: "color:var(--bad)" }, job.error) : null,
      el("div", { style: "margin-top:8px" }, btn), notice),
    research ? el("div", { class: "card" },
      el("strong", {}, `Findings (${research.findings.length})`),
      research.findings.length ? research.findings.map(f => el("div", { class: "finding" },
        el("div", { class: "claim" }, f.claim),
        el("blockquote", {}, f.quote),
        el("div", { class: "small" }, safeLink(f.url, f.title || f.url), el("span", { class: "muted" }, ` · ${f.sourceType} · ${f.site} · ${f.verified ? "quote verified" : "unverified"}`))))
        : el("div", { class: "muted" }, "No findings yet")) : errorBox("Research data unavailable"),
    research && research.sources.length ? el("div", { class: "card" }, el("strong", {}, `Sources (${research.sources.length})`),
      el("table", {}, el("tr", {}, el("th", {}, "source"), el("th", {}, "type"), el("th", {}, "chunks"), el("th", {}, "findings"), el("th", {}, "status")),
        research.sources.map(s => el("tr", {}, el("td", {}, safeLink(s.url, s.title || s.url)), el("td", {}, s.sourceType), el("td", {}, s.chunks), el("td", {}, s.findings),
          el("td", {}, s.error ? el("span", { class: "pill bad" }, s.error) : pill("ok")))))) : null,
    job?.result ? el("details", {}, el("summary", {}, "Latest result JSON"), el("pre", {}, JSON.stringify(job.result, null, 2))) : null
  );
}

async function jobs() {
  const r = await api("/research/jobs");
  if (!r.ok) return render(el("h2", {}, "Research jobs"), errorBox(`GET /research/jobs failed (${r.status})`));
  const ir = await api("/ideas");
  const titles = new Map((ir.ok ? ir.body : []).map(i => [i.id, i.title]));
  render(el("h2", {}, `Research jobs (${r.body.length})`),
    r.body.length ? el("table", {}, el("tr", {}, el("th", {}, "idea"), el("th", {}, "status"), el("th", {}, "attempts"), el("th", {}, "created"), el("th", {}, "completed"), el("th", {}, "kept / verified"), el("th", {}, "error")),
      r.body.map(j => el("tr", {},
        el("td", {}, el("a", { href: `#/idea/${encodeURIComponent(j.ideaId)}` }, titles.get(j.ideaId) || j.ideaId)),
        el("td", {}, pill(j.status)), el("td", {}, j.attempts), el("td", {}, fmtTime(j.created_at)), el("td", {}, fmtTime(j.completed_at)),
        el("td", {}, j.resultCounts ? `${j.resultCounts.findingsKept ?? "?"} / ${j.resultCounts.quotesVerified ?? "?"}` : "—"),
        el("td", { class: "small" }, j.error || "")))) : el("p", { class: "muted" }, "No research jobs"));
}

// ---------- router ----------
async function route() {
  clearTimeout(refreshTimer);
  if (location.hash !== "#/ideas") lastAddNotice = null;
  const h = location.hash || "#/";
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("active",
    a.getAttribute("href") === h || (h.startsWith("#/idea/") && a.getAttribute("href") === "#/ideas")));
  try {
    if (h.startsWith("#/idea/")) await ideaDetail(decodeURIComponent(h.slice(7)));
    else if (h === "#/ideas") await ideas();
    else if (h === "#/jobs") await jobs();
    else await overview();
  } catch (e) { render(errorBox(`Error: ${e && e.message ? e.message : e}`)); }
}
window.addEventListener("hashchange", route);
route();
