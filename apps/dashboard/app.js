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
  const rows = ir.body.filter(i => i.origin !== "topic").map(i => ({ ...i, ev: evals.get(i.id) || null })); // topic-skill anchors live under Skills
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
    skillCard(id),
    chatPanel(id),
    conversationsPanel(id),
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


// ---------- skills (memory palace) ----------
const SKILL_POLL_MS = 15000;
function skillStatus(s, job) {
  const st = job && (job.status === "pending" || job.status === "running") ? job.status : s.status;
  return el("span", {}, pill(st === "ready" ? "completed" : st), st === "ready" ? "" : ` ${st}`, s.version ? el("span", { class: "muted small" }, ` · v${s.version}`) : null);
}

// ---------- web chat (shared conversation store, channel "web") ----------
const JSON_POST = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
// Chat about one idea, embedded on the idea page: continues the latest open web session for the idea, or starts one.
function chatPanel(ideaId) {
  const box = el("div", { class: "card chat-panel" }, el("strong", {}, "Chat about this idea"), el("div", { class: "muted small" }, "Loading…"));
  api(`/chat/sessions?ideaId=${encodeURIComponent(ideaId)}&limit=1`).then(r => {
    const open = r.ok ? r.body.sessions.find(s => !s.endedAt) : null;
    const start = el("button", { onclick: async () => {
      start.disabled = true;
      const c = await api("/chat/sessions", JSON_POST({ ideaId }));
      if (c.status === 201) box.replaceChildren(el("strong", {}, "Chat about this idea"), chatView(c.body.session.id));
      else { start.disabled = false; box.append(errorBox(`Could not start chat (HTTP ${c.status})`)); }
    } }, "Start a chat");
    box.replaceChildren(el("strong", {}, "Chat about this idea"), open ? chatView(open.id) : el("div", {}, el("p", { class: "muted small" }, "Chats here are shared with the AIPI: it recaps them when you open this idea by voice."), start));
  });
  return box;
}
// One chat session: transcript, input, close, attach-to-idea (general chats), and keyword action cards.
function chatView(sessionId) {
  const wrap = el("div", { class: "chat" }); let sid = sessionId;
  const log = el("div", { class: "chat-log" }); const actions = el("div", {}); const status = el("div", { class: "small muted" });
  const input = el("textarea", { class: "wide", rows: 3, placeholder: "Message… (try “make this an idea” or “add this as a skill”)" });
  const who = { user: "You", assistant: "Bailey", note: "Note" };
  const msgNode = m => el("div", { class: `chat-msg ${m.role}` }, el("span", { class: `channel ${m.channel}` }, m.channel), " ", el("strong", {}, `${who[m.role] || m.role}: `), el("span", { class: "prose" }, m.text));
  const head = el("div", { class: "small muted" });
  const linkTo = (kind, targetId) => api(`/chat/sessions/${encodeURIComponent(sid)}/links`, JSON_POST({ kind, targetId }));
  function ideaDraftCard(draft) {
    const t = el("input", { class: "wide", value: draft.title, maxlength: 200 }); const c = el("textarea", { class: "wide", rows: 4 }); c.value = draft.content;
    const note = el("div", {}); const ok = el("button", { onclick: async () => {
      ok.disabled = true;
      const r = await api("/ideas", JSON_POST({ title: t.value.trim(), content: c.value.trim() }));
      if (r.status === 201) { await linkTo("created_idea", r.body.idea.id); card.replaceChildren(el("div", { class: "notice ok" }, "Idea added to the queue: ", el("a", { href: `#/idea/${encodeURIComponent(r.body.idea.id)}` }, r.body.idea.title))); refresh(); }
      else { ok.disabled = false; note.replaceChildren(errorBox(`Could not add idea (HTTP ${r.status})`)); }
    } }, "Confirm");
    const card = el("div", { class: "card draft" }, el("strong", {}, "Draft idea"), el("div", { class: "muted small" }, "Drafted from this conversation only. Edit, then confirm to add it (it will be expanded, evaluated and researched)."), t, c,
      el("div", {}, ok, " ", el("button", { class: "secondary", onclick: () => card.remove() }, "Cancel")), note);
    return card;
  }
  function skillDraftCard(p) {
    const note = el("div", {}); const ok = el("button", { onclick: async () => {
      ok.disabled = true;
      const r = p.mode === "idea" ? await api(`/ideas/${encodeURIComponent(p.ideaId)}/skill`, JSON_POST({})) : await api("/skills/topic", JSON_POST({ topic: p.topic, seed: p.seed, sessionId: sid }));
      if (r.status === 202) { if (p.mode === "idea") await linkTo("queued_skill", r.body.skillId); card.replaceChildren(el("div", { class: "notice ok" }, "Deep dive queued: ", el("a", { href: `#/skill/${encodeURIComponent(r.body.skillId)}` }, p.mode === "idea" ? p.ideaTitle : p.topic))); }
      else if (r.status === 409) card.replaceChildren(el("div", { class: "notice warn" }, r.body?.activeJobId ? "A deep dive is already running for that." : "That's already a skill.", r.body?.skillId ? [" ", el("a", { href: `#/skill/${encodeURIComponent(r.body.skillId)}` }, "Open it")] : null));
      else { ok.disabled = false; note.replaceChildren(errorBox(`Could not queue the deep dive (HTTP ${r.status})`)); }
    } }, "Confirm");
    const card = el("div", { class: "card draft" }, el("strong", {}, p.mode === "idea" ? `Deep dive on this idea: ${p.ideaTitle}` : `New topic skill: ${p.topic}`),
      p.mode === "topic" ? el("div", { class: "small" }, "Seed: ", p.seed) : null,
      el("div", { class: "muted small" }, p.mode === "idea" ? "Uses the existing “Make this a skill” deep dive." : `Not tied to an idea${p.fit != null ? ` (fit with the open idea ${p.fit} < threshold)` : ""}.`),
      el("div", {}, ok, " ", el("button", { class: "secondary", onclick: () => card.remove() }, "Cancel")), note);
    return card;
  }
  async function refresh() {
    const r = await api(`/chat/sessions/${encodeURIComponent(sid)}`);
    if (!r.ok) { wrap.replaceChildren(errorBox(`Chat unavailable (HTTP ${r.status})`)); return; }
    const s = r.body.session;
    log.replaceChildren(...(r.body.messages.length ? r.body.messages.map(msgNode) : [el("p", { class: "muted small" }, "No messages yet.")]));
    head.replaceChildren(s.ideaId ? ["About ", el("a", { href: `#/idea/${encodeURIComponent(s.ideaId)}` }, "this idea")] : "General chat (not tied to an idea)", ` · started ${fmtTime(s.startedAt)}`, s.endedAt ? ` · closed (${s.endReason})` : "");
    if (!s.ideaId && !attachBox.childNodes.length) {
      const ir = await api("/ideas"); const sel = el("select", {}, el("option", { value: "" }, "Attach to idea…"), ...(ir.ok ? ir.body.filter(i => i.origin !== "topic").map(i => el("option", { value: i.id }, i.title)) : []));
      attachBox.replaceChildren(sel, " ", el("button", { class: "secondary", onclick: async () => { if (!sel.value) return; const a = await api(`/chat/sessions/${encodeURIComponent(sid)}/attach`, JSON_POST({ ideaId: sel.value })); if (a.ok) { attachBox.replaceChildren(); refresh(); } else status.textContent = `Attach failed (HTTP ${a.status})`; } }, "Attach"));
    } else if (s.ideaId) attachBox.replaceChildren();
  }
  const attachBox = el("span", {});
  const send = el("button", { onclick: async () => {
    const text = input.value.trim(); if (!text) return;
    send.disabled = true; status.textContent = "Bailey is thinking…"; log.append(msgNode({ role: "user", channel: "web", text }));
    const r = await api(`/chat/sessions/${encodeURIComponent(sid)}/messages`, JSON_POST({ text }));
    send.disabled = false; status.textContent = "";
    if (!r.ok) { status.textContent = `Send failed (HTTP ${r.status})`; return; }
    input.value = "";
    if (r.body.continuedFrom) { sid = r.body.sessionId; status.textContent = "The previous chat was closed, so this continues in a new session."; }
    await refresh();
    if (r.body.action?.type === "idea_draft") actions.append(ideaDraftCard(r.body.action.draft));
    if (r.body.action?.type === "skill_draft") actions.append(skillDraftCard(r.body.action.proposal));
  } }, "Send");
  const close = el("button", { class: "secondary", onclick: async () => { const r = await api(`/chat/sessions/${encodeURIComponent(sid)}/close`, JSON_POST({})); status.textContent = r.ok ? (r.body.summaryQueued ? "Closed. A summary is being written for the AIPI recap." : "Closed.") : `Close failed (HTTP ${r.status})`; refresh(); } }, "Close chat");
  wrap.append(head, log, actions, input, el("div", {}, send, " ", close, " ", attachBox), status);
  refresh();
  return wrap;
}
// #/chat: general chats (and every web chat), newest first. #/chat/<id>: one chat.
async function chatList() {
  const r = await api("/chat/sessions?limit=100");
  const start = el("button", { onclick: async () => { const c = await api("/chat/sessions", JSON_POST({})); if (c.status === 201) location.hash = `#/chat/${encodeURIComponent(c.body.session.id)}`; } }, "New general chat");
  render(el("h2", {}, "Chat"), el("p", {}, start),
    !r.ok ? errorBox(`GET /chat/sessions failed (${r.status})`) : r.body.sessions.length ? el("table", {}, el("tr", {}, el("th", {}, "chat"), el("th", {}, "idea"), el("th", {}, "messages"), el("th", {}, "last activity"), el("th", {}, "state")),
      r.body.sessions.map(s => el("tr", {}, el("td", {}, el("a", { href: `#/chat/${encodeURIComponent(s.id)}` }, fmtTime(s.startedAt))), el("td", {}, s.ideaId ? el("a", { href: `#/idea/${encodeURIComponent(s.ideaId)}` }, "idea") : el("span", { class: "muted" }, "general")),
        el("td", {}, s.messageCount), el("td", {}, fmtTime(s.lastActivityAt)), el("td", {}, s.endedAt ? pill("completed") : pill("running")))))
      : el("p", { class: "muted" }, "No web chats yet."));
}
async function chatPage(id) { render(el("p", {}, el("a", { href: "#/chat" }, "← Chat")), el("h2", {}, "Chat"), el("div", { class: "card" }, chatView(id))); }

// Conversations panel on the idea page: history across channels (voice / web) plus the rolling summary. Read-only.
function conversationsPanel(ideaId) {
  const box = el("div", { class: "card conversations" }, el("span", { class: "muted" }, "Loading conversations…"));
  api(`/ideas/${encodeURIComponent(ideaId)}/conversations`).then(r => {
    if (!r.ok) { box.replaceChildren(el("span", { class: "muted" }, `Conversations unavailable (HTTP ${r.status})`)); return; }
    const { summary, sessions } = r.body;
    const who = { user: "You", assistant: "Bailey", note: "Note" };
    box.replaceChildren(
      el("strong", {}, `Conversations (${sessions.length})`),
      summary ? el("div", { class: "conv-summary" }, el("span", { class: "kind synthesis" }, "summary"), " ", summary.text,
        el("div", { class: "muted small" }, `updated ${fmtTime(summary.updatedAt)} · ${summary.model}`)) : el("div", { class: "muted small" }, "No summary yet. One is written when a conversation ends."),
      sessions.length ? sessions.map((s, i) => el("details", { class: "conv-session", open: i === 0 ? true : null },
        el("summary", {}, el("span", { class: `channel ${s.channel}` }, s.channel), ` ${fmtTime(s.startedAt)} · ${s.messages.length} messages`,
          s.endedAt ? el("span", { class: "muted small" }, ` · ended (${s.endReason || "closed"})`) : el("span", { class: "pill running" }, "open")),
        s.messages.map(m => el("div", { class: `conv-msg ${m.role}` }, el("span", { class: `channel ${m.channel}` }, m.channel), " ",
          el("strong", {}, `${who[m.role] || m.role}: `), m.text, el("span", { class: "muted small" }, ` ${fmtTime(m.createdAt)}`)))))
        : el("div", { class: "muted" }, "No conversations yet. Say “let's talk about …” to the AIPI."));
  }).catch(e => box.replaceChildren(el("span", { class: "muted" }, `Conversations unavailable: ${e && e.message ? e.message : e}`)));
  return box;
}

// "Make this a skill" card on the idea page, with live status.
function skillCard(ideaId) {
  const box = el("div", { class: "card skill-card" }, el("span", { class: "muted" }, "Checking skill…"));
  let timer = null;
  const load = async () => {
    clearTimeout(timer);
    if (!document.body.contains(box) && timer !== null) return;
    const r = await api(`/ideas/${encodeURIComponent(ideaId)}/skill`);
    if (!r.ok) { box.replaceChildren(errorBox(`GET /ideas/:id/skill failed (${r.status})`)); return; }
    const { skill, latestJob } = r.body;
    const notice = el("div", {});
    if (!skill) {
      const b = el("button", { onclick: async () => {
        b.disabled = true;
        const x = await api(`/ideas/${encodeURIComponent(ideaId)}/skill`, { method: "POST" });
        if (x.status === 202) await load();
        else { notice.replaceChildren(el("div", { class: "notice bad" }, `Could not create skill (HTTP ${x.status}): ${x.body?.error ?? ""}`)); b.disabled = false; }
      } }, "Make this a skill");
      box.replaceChildren(el("strong", {}, "Skill "), el("span", { class: "muted small" }, "A deep dive: more questions and sources, then a write-up built from verified facts."), el("div", { style: "margin-top:8px" }, b), notice);
      return;
    }
    const active = latestJob && (latestJob.status === "pending" || latestJob.status === "running");
    box.replaceChildren(el("strong", {}, "Skill: "), el("a", { href: `#/skill/${encodeURIComponent(skill.id)}` }, skill.title), " ", skillStatus(skill, latestJob),
      active ? el("div", { class: "small muted" }, `Deep dive ${latestJob.status} (v${latestJob.version}). The deep-dive worker must be running to process it.`) : null,
      skill.status === "failed" && skill.error ? el("div", { class: "small", style: "color:var(--bad)" }, skill.error) : null);
    if (active) timer = setTimeout(() => { if (document.body.contains(box)) load(); }, SKILL_POLL_MS);
  };
  load();
  return box;
}

let skillQuery = "";
async function skills() {
  const input = el("input", { type: "search", placeholder: "Search skills (title, summary, tags, content)…", class: "wide", value: skillQuery });
  const results = el("div", {}, el("p", { class: "muted" }, "Loading…"));
  let debounce = null;
  const load = async () => {
    const r = await api(`/skills${skillQuery ? `?q=${encodeURIComponent(skillQuery)}` : ""}`);
    if (!r.ok) { results.replaceChildren(errorBox(`GET /skills failed (${r.status})`)); return; }
    if (!r.body.length) { results.replaceChildren(el("p", { class: "muted" }, skillQuery ? "No skills match." : "No skills yet. Open an idea and press “Make this a skill”.")); return; }
    const groups = new Map();
    for (const s of r.body) { const t = s.topic || "uncategorized"; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(s); }
    const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    results.replaceChildren(...ordered.map(([topic, list]) => el("section", { class: "topic" },
      el("h3", {}, topic, el("span", { class: "muted small" }, ` · ${list.length}`)),
      el("div", { class: "grid" }, list.map(s => el("a", { class: "card skill-tile", href: `#/skill/${encodeURIComponent(s.id)}` },
        el("div", { class: "tile-title" }, s.title),
        el("div", { class: "small" }, skillStatus(s, s.latestJob), el("span", { class: "muted" }, ` · ${s.facts} verified facts · ${s.sources} sources`)),
        s.summary ? el("div", { class: "small tile-summary" }, s.summary) : null,
        s.tags.length ? el("div", {}, s.tags.map(t => el("span", { class: "tag" }, t))) : null))))));
  };
  input.addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(() => { skillQuery = input.value.trim(); load(); }, 250); });
  render(el("h2", {}, "Skills palace"), input, results);
  await load();
  input.focus();
}

// Mermaid is vendored locally (/dashboard/mermaid.min.js) and loaded on demand; securityLevel "strict".
let mermaidReady = null;
function loadMermaid() {
  if (!mermaidReady) mermaidReady = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "/dashboard/mermaid.min.js";
    sc.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: { htmlLabels: false } }); resolve(window.mermaid); } catch (e) { reject(e); } };
    sc.onerror = () => reject(new Error("mermaid.min.js failed to load"));
    document.head.append(sc);
  });
  return mermaidReady;
}
let diagramSeq = 0;
function diagramBox(d) {
  const target = el("div", { class: "diagram" }, el("span", { class: "muted small" }, "Rendering diagram…"));
  const code = el("details", {}, el("summary", { class: "small muted" }, "Mermaid source"), el("pre", {}, d.mermaid));
  loadMermaid().then(async (m) => {
    const { svg } = await m.render(`skill-diagram-${++diagramSeq}`, d.mermaid);
    // Parse the (strict-mode, sanitized) SVG as XML and import the node; no HTML parsing of untrusted text.
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== "svg") throw new Error("renderer did not return SVG");
    target.replaceChildren(document.importNode(root, true));
  }).catch(e => target.replaceChildren(el("div", { class: "notice warn small" }, `Diagram could not be rendered (${e && e.message ? e.message : e}); source below.`)));
  return el("div", { class: "diagram-wrap" }, el("div", { class: "small" }, el("strong", {}, d.title), d.refs && d.refs.length ? el("span", { class: "muted" }, ` · uses ${d.refs.map(n => `F${n}`).join(", ")}`) : null), target, code);
}

function citeText(text) {
  // Renders "[F3]" citations as links to the fact anchors; everything else stays a text node.
  const parts = String(text || "").split(/(\[F\d+\])/g);
  return parts.map(p => { const m = /^\[F(\d+)\]$/.exec(p); return m ? el("a", { href: "#", class: "cite", onclick: (e) => { e.preventDefault(); document.getElementById(`fact-${m[1]}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); } }, p) : p; });
}

async function skillDetail(id, version) {
  const r = await api(`/skills/${encodeURIComponent(id)}${version ? `?version=${encodeURIComponent(version)}` : ""}`);
  if (r.status === 404) return render(el("p", {}, el("a", { href: "#/skills" }, "← Skills")), errorBox("Skill or version not found"));
  if (!r.ok) return render(errorBox(`GET /skills/:id failed (${r.status})`));
  const d = r.body, s = d.skill, job = d.latestJob;
  const active = job && (job.status === "pending" || job.status === "running");
  const notice = el("div", {});
  const refresh = el("button", { disabled: active || null, onclick: async () => {
    refresh.disabled = true;
    const x = await api(`/skills/${encodeURIComponent(id)}/refresh`, { method: "POST" });
    if (x.status === 202) notice.replaceChildren(el("div", { class: "notice ok" }, `Refresh queued as version ${x.body.version}. The current version stays readable until it finishes.`));
    else if (x.status === 409) notice.replaceChildren(el("div", { class: "notice warn" }, "A deep dive is already running for this skill."));
    else { notice.replaceChildren(el("div", { class: "notice bad" }, `Could not refresh (HTTP ${x.status}).`)); refresh.disabled = false; }
  } }, "Refresh (new version)");
  const sec = (k) => d.sections.find(x => x.key === k);
  const kind = (x) => el("span", { class: `kind ${x.kind}` }, x.kind === "verified" ? "verified facts" : x.kind === "computed" ? "computed" : "synthesis");
  const head = (x) => el("h3", {}, x.title, " ", kind(x));
  const prose = (k) => { const x = sec(k); return x ? el("section", { class: "card" }, head(x), x.text ? el("p", { class: "prose" }, citeText(x.text)) : el("p", { class: "muted" }, "Nothing written.")) : null; };
  const list = (k, ordered) => { const x = sec(k); return x ? el("section", { class: "card" }, head(x), (x.items || []).length ? el(ordered ? "ol" : "ul", {}, x.items.map(i => el("li", {}, citeText(i)))) : el("p", { class: "muted" }, "None.")) : null; };
  const facts = sec("key_facts");
  const rel = (sec("related")?.items || [])[0] || { ideas: [], skills: [] };
  const viewingOld = d.viewVersion && d.viewVersion !== s.version;
  render(
    el("p", {}, el("a", { href: "#/skills" }, "← Skills")),
    el("h2", {}, s.title),
    el("div", { class: "card" },
      el("div", {}, skillStatus(s, job), el("span", { class: "muted small" }, ` · topic ${s.topic} · parent idea `), el("a", { href: `#/idea/${encodeURIComponent(d.idea.id)}` }, d.idea.title)),
      d.summary ? el("p", {}, d.summary) : null,
      d.tags.length ? el("div", {}, d.tags.map(t => el("span", { class: "tag" }, t))) : null,
      active ? el("div", { class: "small muted" }, `Deep dive ${job.status} for v${job.version}.`) : null,
      s.status === "failed" && s.error ? el("div", { class: "small", style: "color:var(--bad)" }, s.error) : null,
      el("div", { style: "margin-top:8px" }, refresh), notice),
    viewingOld ? el("div", { class: "notice warn" }, `You are viewing version ${d.viewVersion}. `, el("a", { href: `#/skill/${encodeURIComponent(id)}` }, `Go to current (v${s.version})`)) : null,
    !d.viewVersion ? el("div", { class: "card muted" }, "No completed version yet. The write-up appears here when the deep dive finishes.") : null,
    d.viewVersion ? [
      el("p", { class: "muted small" }, "Sections marked “synthesis” are the model’s write-up from the verified facts below (citations like [F2] point at them); only “Key facts” are quote-verified."),
      prose("overview"), prose("how_it_works"),
      facts ? el("section", { class: "card" }, head(facts), (facts.items || []).length ? facts.items.map(f => el("div", { class: "finding", id: `fact-${f.n}` },
        el("div", { class: "claim" }, `F${f.n}. `, f.claim), el("blockquote", {}, f.quote),
        el("div", { class: "small" }, safeLink(f.url, f.title || f.url), el("span", { class: "muted" }, ` · ${f.sourceType} · ${f.site}${f.question ? ` · Q: ${f.question}` : ""}`))))
        : el("p", { class: "muted" }, "No verified facts.")) : null,
      sec("diagrams") ? el("section", { class: "card" }, head(sec("diagrams")), el("p", { class: "muted small" }, "Generated from the verified facts and the synthesis; nodes that state a fact cite it as [F#]."),
        (sec("diagrams").items || []).map(diagramBox)) : null,
      list("practical_steps", true), list("open_questions", false),
      el("section", { class: "card" }, el("h3", {}, "Related ", el("span", { class: "kind computed" }, "embedding similarity")),
        el("div", {}, el("strong", {}, "Skills: "), rel.skills.length ? rel.skills.map((x, i) => [i ? ", " : "", el("a", { href: `#/skill/${encodeURIComponent(x.id)}` }, x.title), el("span", { class: "muted small" }, ` (${x.similarity})`)]) : el("span", { class: "muted" }, "none yet")),
        el("div", {}, el("strong", {}, "Ideas: "), rel.ideas.length ? rel.ideas.map((x, i) => [i ? ", " : "", el("a", { href: `#/idea/${encodeURIComponent(x.id)}` }, x.title), el("span", { class: "muted small" }, ` (${x.similarity})`)]) : el("span", { class: "muted" }, "none above threshold"))),
      d.sources.length ? el("section", { class: "card" }, el("h3", {}, `Sources (${d.sources.length})`),
        el("ul", {}, d.sources.map(x => el("li", {}, safeLink(x.url, x.title || x.url), el("span", { class: "muted small" }, ` · ${x.sourceType} · ${x.cited ? "cited in key facts" : "read, not cited"}`))))) : null
    ] : null,
    el("section", { class: "card" }, el("h3", {}, "Version history"),
      d.versions.length ? el("table", {}, el("tr", {}, el("th", {}, "version"), el("th", {}, "created"), el("th", {}, "verified facts"), el("th", {}, "duration")),
        d.versions.map(v => el("tr", {}, el("td", {}, v.version === d.viewVersion ? el("strong", {}, `v${v.version} (viewing)`) : el("a", { href: `#/skill/${encodeURIComponent(id)}@${v.version}` }, `v${v.version}`), v.version === s.version ? " current" : ""),
          el("td", {}, fmtTime(v.created_at)), el("td", {}, v.verifiedFacts ?? "—"), el("td", {}, v.total_ms != null ? `${Math.round(v.total_ms / 1000)} s` : "—"))))
        : el("p", { class: "muted" }, "No versions yet."))
  );
  if (active) refreshTimer = setTimeout(() => { if (location.hash.startsWith(`#/skill/${encodeURIComponent(id)}`)) route(); }, SKILL_POLL_MS);
}

// ---------- router ----------
async function route() {
  clearTimeout(refreshTimer);
  if (location.hash !== "#/ideas") lastAddNotice = null;
  const h = location.hash || "#/";
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("active",
    a.getAttribute("href") === h || (h.startsWith("#/idea/") && a.getAttribute("href") === "#/ideas") || (h.startsWith("#/skill/") && a.getAttribute("href") === "#/skills") || (h.startsWith("#/chat/") && a.getAttribute("href") === "#/chat")));
  try {
    if (h.startsWith("#/idea/")) await ideaDetail(decodeURIComponent(h.slice(7)));
    else if (h.startsWith("#/skill/")) { const [sid, ver] = decodeURIComponent(h.slice(8)).split("@"); await skillDetail(sid, ver); }
    else if (h === "#/skills") await skills();
    else if (h === "#/chat") await chatList();
    else if (h.startsWith("#/chat/")) await chatPage(decodeURIComponent(h.slice(7)));
    else if (h === "#/ideas") await ideas();
    else if (h === "#/jobs") await jobs();
    else await overview();
  } catch (e) { render(errorBox(`Error: ${e && e.message ? e.message : e}`)); }
}
window.addEventListener("hashchange", route);
route();
