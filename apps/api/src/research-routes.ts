// Research API + local dashboard static files, as a Fastify plugin.
// Uses its own better-sqlite3 connection (BRAIN_DB ?? ./data/brain.sqlite), like the other modules.

import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { createResearchJobStore, ActiveResearchJobError } from "./research-jobs.js";
import { siteKey, sourceType } from "./research.js";

export type ResearchRoutesOptions = {
  db: Database.Database;
  dashboardDir?: string;
  searxngUrl?: string;
  ollamaUrl?: string;
  probeTimeoutMs?: number;
};

/** Fixed allowlist: URL path -> file name + content type. Nothing else is ever read from disk. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/dashboard/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/dashboard/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" }
};

const DEFAULT_DASHBOARD_DIR = fileURLToPath(new URL("../../dashboard/", import.meta.url));
const IdParams = z.object({ id: z.string().trim().min(1).max(128) });
const STATUSES = ["pending", "running", "completed", "failed"] as const;

function parseJson(s: string | null): unknown {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Small summary of a research job's result JSON (counts only). */
function resultCounts(r: any) {
  if (!r || typeof r !== "object") return null;
  const pick = ["sources", "fetched", "fetchFailed", "quotesVerified", "findingsKept", "findingsInserted",
    "droppedUnsupported", "droppedPartial", "droppedNoQuestion", "droppedSourceCap", "droppedUnchecked"];
  const out: Record<string, unknown> = {};
  for (const k of pick) if (k in r) out[k] = r[k];
  if (r.timings?.total_ms != null) out.total_ms = r.timings.total_ms;
  return out;
}

async function probe(url: string, timeoutMs: number) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => undefined);
    return { reachable: res.ok, httpStatus: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { reachable: false, error: String(e instanceof Error ? e.message : e).slice(0, 200), ms: Date.now() - t0 };
  }
}

export async function researchRoutes(app: FastifyInstance, opts: ResearchRoutesOptions) {
  const { db } = opts;
  const dashboardDir = opts.dashboardDir ?? DEFAULT_DASHBOARD_DIR;
  const searxngUrl = opts.searxngUrl ?? process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
  const probeMs = opts.probeTimeoutMs ?? 2000;
  const store = createResearchJobStore(db);

  const ideaById = db.prepare(`SELECT id, title FROM ideas WHERE id = ?`);
  const findingsFor = db.prepare(`
    SELECT f.id, f.idea_id, f.claim, f.quote, f.verified, f.created_at,
           s.id AS source_id, COALESCE(s.final_url, s.url) AS url, s.title
    FROM research_findings f
    JOIN research_chunks c ON c.id = f.chunk_id
    JOIN research_sources s ON s.id = c.source_id
    WHERE (? IS NULL OR f.idea_id = ?)
    ORDER BY f.created_at DESC, f.id
    LIMIT 500`);
  const sourcesFor = db.prepare(`
    SELECT s.id, COALESCE(s.final_url, s.url) AS url, s.title, s.http_status, s.error, s.fetched_at,
           (SELECT COUNT(*) FROM research_chunks c WHERE c.source_id = s.id) AS chunks,
           (SELECT COUNT(*) FROM research_findings f JOIN research_chunks c ON c.id = f.chunk_id WHERE c.source_id = s.id) AS findings
    FROM research_sources s WHERE s.idea_id = ? ORDER BY s.fetched_at DESC, s.id`);
  const jobsAll = db.prepare(`
    SELECT id, json_extract(payload, '$.ideaId') AS ideaId, status, attempts, error, created_at, completed_at, result
    FROM jobs WHERE type = 'research_idea' AND (? IS NULL OR status = ?)
    ORDER BY created_at DESC, id LIMIT 200`);
  const latestJobFor = db.prepare(`
    SELECT id, status, attempts, error, created_at, completed_at, result
    FROM jobs WHERE type = 'research_idea' AND json_extract(payload, '$.ideaId') = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);

  const withType = (r: { url: string }) => ({ ...r, site: siteKey(r.url), sourceType: sourceType(r.url) });

  app.get("/research/findings", async (request, reply) => {
    const q = z.object({ ideaId: z.string().trim().min(1).max(128).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.issues });
    const id = q.data.ideaId ?? null;
    return (findingsFor.all(id, id) as Array<{ url: string }>).map(withType);
  });

  app.get("/ideas/:id/research", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid idea id" });
    const idea = ideaById.get(p.data.id);
    if (!idea) return reply.code(404).send({ error: "Idea not found" });
    const job = latestJobFor.get(p.data.id) as any;
    return {
      idea,
      findings: (findingsFor.all(p.data.id, p.data.id) as Array<{ url: string }>).map(withType),
      sources: (sourcesFor.all(p.data.id) as Array<{ url: string }>).map(withType),
      latestJob: job ? { ...job, result: parseJson(job.result) } : null
    };
  });

  app.get("/research/jobs", async (request, reply) => {
    const q = z.object({ status: z.enum(STATUSES).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid status", details: q.error.issues });
    const s = q.data.status ?? null;
    return (jobsAll.all(s, s) as any[]).map(({ result, ...j }) => ({ ...j, resultCounts: resultCounts(parseJson(result)) }));
  });

  app.post("/ideas/:id/research", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid idea id" });
    if (!ideaById.get(p.data.id)) return reply.code(404).send({ error: "Idea not found" });
    try {
      const jobId = store.enqueue(p.data.id);
      return reply.code(202).send({ jobId, ideaId: p.data.id, status: "pending" });
    } catch (e) {
      if (e instanceof ActiveResearchJobError) {
        return reply.code(409).send({ error: "A research job is already active for this idea", activeJobId: e.jobId });
      }
      throw e;
    }
  });

  app.get("/status", async () => {
    const now = Date.now();
    const jobs = db.prepare(`SELECT type, status, COUNT(*) AS count FROM jobs GROUP BY type, status ORDER BY type, status`).all();
    const evaluationJobs = db.prepare(`SELECT status, COUNT(*) AS count FROM evaluation_jobs GROUP BY status ORDER BY status`).all();
    const lockRow = db.prepare(`SELECT name, owner, lease_until, acquired_at FROM inference_lock`).all() as any[];
    const activeLeases = db.prepare(`
      SELECT 'jobs:' || type AS queue, COUNT(*) AS count FROM jobs WHERE status = 'running' AND lease_until > ? GROUP BY type
      UNION ALL SELECT 'evaluation_jobs', COUNT(*) FROM evaluation_jobs WHERE status = 'running' AND lease_until > ?`).all(now, now);
    const lastCompleted = db.prepare(`
      SELECT 'jobs:' || type AS queue, MAX(completed_at) AS at FROM jobs WHERE completed_at IS NOT NULL GROUP BY type
      UNION ALL SELECT 'evaluation_jobs', MAX(completed_at) FROM evaluation_jobs WHERE completed_at IS NOT NULL`).all();
    const [searxng, ollama] = await Promise.all([
      probe(`${searxngUrl}/healthz`, probeMs).then(r => r.reachable ? r : probe(`${searxngUrl}/`, probeMs)),
      probe(`${ollamaUrl}/api/tags`, probeMs)
    ]);
    return {
      now,
      jobs, evaluationJobs,
      inferenceLock: lockRow.map(l => ({ ...l, held: !!l.owner && l.lease_until > now })),
      workers: {
        note: "Workers are not registered; liveness is inferred only from unexpired running leases and last completion times.",
        activeLeases: (activeLeases as any[]).filter(r => r.count > 0), lastCompleted
      },
      searxng: { url: searxngUrl, ...searxng },
      ollama: { url: ollamaUrl, ...ollama }
    };
  });

  for (const [path, f] of Object.entries(STATIC_FILES)) {
    app.get(path, async (_request, reply) => {
      try {
        const body = await readFile(join(dashboardDir, f.file));
        return reply.type(f.type).header("cache-control", "no-cache").send(body);
      } catch {
        return reply.code(404).send({ error: "Dashboard file missing" });
      }
    });
  }
}
