// Skills ("memory palace") API. Additive routes only; uses the shared better-sqlite3 connection.
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { ensureSkillTables } from "./skills-schema.js";
import { createSkillStore, ActiveDeepDiveError, SkillExistsError, NotFoundError, DEEP_DIVE_JOB } from "./skill-jobs.js";
import { cosine, fromBlob, siteKey, sourceType } from "./research.js";

const IdParams = z.object({ id: z.string().trim().min(1).max(128) });
const parse = (s: string | null, d: unknown = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };

/** Greedy single-pass clustering on skill embeddings; label = most common tag in the cluster. */
export function clusterTopics(items: Array<{ id: string; tags: string[]; vec: Float32Array | null }>, threshold = 0.62) {
  const clusters: Array<{ members: typeof items; centroid: Float32Array | null }> = [];
  for (const it of items) {
    let best = -1, bestSim = threshold;
    if (it.vec) clusters.forEach((c, i) => { if (c.centroid) { const s = cosine(it.vec!, c.centroid); if (s >= bestSim) { bestSim = s; best = i; } } });
    if (best < 0) clusters.push({ members: [it], centroid: it.vec ? Float32Array.from(it.vec) : null });
    else {
      const c = clusters[best]!; c.members.push(it);
      const k = c.members.length; c.centroid = c.centroid!.map((v, j) => v + (it.vec![j]! - v) / k);
    }
  }
  const topic = new Map<string, string>();
  for (const c of clusters) {
    const counts = new Map<string, number>();
    for (const m of c.members) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const label = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "uncategorized";
    for (const m of c.members) topic.set(m.id, label);
  }
  return topic;
}

export async function skillsRoutes(app: FastifyInstance, opts: { db: Database.Database }) {
  const { db } = opts;
  ensureSkillTables(db);   // idempotent, additive
  const store = createSkillStore(db);

  const listStmt = db.prepare(`
    SELECT s.id, s.idea_id, i.title AS idea_title, s.title, s.status, s.summary, s.tags, s.version, s.error, s.created_at, s.updated_at,
      (SELECT COUNT(*) FROM skill_findings f WHERE f.skill_id = s.id AND f.version = s.version) AS facts,
      (SELECT COUNT(*) FROM skill_sources x WHERE x.skill_id = s.id AND x.version = s.version) AS sources
    FROM skills s JOIN ideas i ON i.id = s.idea_id
    WHERE (? IS NULL OR s.title LIKE ? ESCAPE '\\' OR s.summary LIKE ? ESCAPE '\\' OR s.tags LIKE ? ESCAPE '\\' OR s.sections LIKE ? ESCAPE '\\' OR i.content LIKE ? ESCAPE '\\')
    ORDER BY s.updated_at DESC LIMIT 500`);
  const embStmt = db.prepare(`SELECT skill_id, vector FROM skill_embeddings`);
  const skillStmt = db.prepare(`SELECT s.*, i.title AS idea_title FROM skills s JOIN ideas i ON i.id = s.idea_id WHERE s.id = ?`);
  const versionsStmt = db.prepare(`SELECT version, job_id, created_at, stats FROM skill_versions WHERE skill_id = ? ORDER BY version DESC`);
  const versionStmt = db.prepare(`SELECT version, summary, sections, tags, stats, created_at FROM skill_versions WHERE skill_id = ? AND version = ?`);
  const findingsStmt = db.prepare(`
    SELECT f.id, f.claim, f.quote, f.question, f.verified, s.id AS source_id, COALESCE(s.final_url, s.url) AS url, s.title
    FROM skill_findings f JOIN research_chunks c ON c.id = f.chunk_id JOIN research_sources s ON s.id = c.source_id
    WHERE f.skill_id = ? AND f.version = ? ORDER BY f.rowid`);
  const sourcesStmt = db.prepare(`
    SELECT s.id, COALESCE(s.final_url, s.url) AS url, s.title, x.cited FROM skill_sources x JOIN research_sources s ON s.id = x.source_id
    WHERE x.skill_id = ? AND x.version = ? ORDER BY x.cited DESC, s.title`);
  const latestJobStmt = db.prepare(`
    SELECT id, status, attempts, error, created_at, completed_at, json_extract(payload,'$.version') AS version FROM jobs
    WHERE type = '${DEEP_DIVE_JOB}' AND json_extract(payload, '$.skillId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const skillForIdea = db.prepare(`SELECT id FROM skills WHERE idea_id = ?`).pluck();
  const ideaExists = db.prepare(`SELECT id, title FROM ideas WHERE id = ?`);
  const withType = <T extends { url: string }>(r: T) => ({ ...r, site: siteKey(r.url), sourceType: sourceType(r.url) });

  const topics = () => {
    const vecs = new Map((embStmt.all() as Array<{ skill_id: string; vector: Buffer }>).map(e => [e.skill_id, fromBlob(e.vector)]));
    return clusterTopics((db.prepare(`SELECT id, tags FROM skills ORDER BY created_at, id`).all() as Array<{ id: string; tags: string | null }>)
      .map(s => ({ id: s.id, tags: parse(s.tags, []) as string[], vec: vecs.get(s.id) ?? null })));
  };

  app.post("/ideas/:id/skill", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid idea id" });
    try {
      const r = store.create(p.data.id);
      return reply.code(202).send({ ...r, status: "pending" });
    } catch (e) {
      if (e instanceof NotFoundError) return reply.code(404).send({ error: "Idea not found" });
      if (e instanceof ActiveDeepDiveError) return reply.code(409).send({ error: "A deep-dive job is already active for this skill", skillId: e.skillId, activeJobId: e.jobId });
      if (e instanceof SkillExistsError) return reply.code(409).send({ error: "A skill already exists for this idea; use POST /skills/:id/refresh", skillId: e.skillId });
      throw e;
    }
  });

  app.get("/ideas/:id/skill", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid idea id" });
    if (!ideaExists.get(p.data.id)) return reply.code(404).send({ error: "Idea not found" });
    const id = skillForIdea.get(p.data.id) as string | undefined;
    if (!id) return { skill: null, latestJob: null };
    const s = skillStmt.get(id) as any;
    return { skill: { id: s.id, title: s.title, status: s.status, version: s.version, error: s.error, updated_at: s.updated_at }, latestJob: latestJobStmt.get(id) ?? null };
  });

  app.post("/skills/:id/refresh", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid skill id" });
    try {
      const r = store.refresh(p.data.id);
      return reply.code(202).send({ ...r, status: "pending" });
    } catch (e) {
      if (e instanceof NotFoundError) return reply.code(404).send({ error: "Skill not found" });
      if (e instanceof ActiveDeepDiveError) return reply.code(409).send({ error: "A deep-dive job is already active for this skill", skillId: e.skillId, activeJobId: e.jobId });
      throw e;
    }
  });

  app.get("/skills", async (request, reply) => {
    const q = z.object({ q: z.string().trim().max(200).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid query", details: q.error.issues });
    const term = q.data.q ? `%${q.data.q.replace(/[\\%_]/g, m => "\\" + m)}%` : null;
    const t = topics();
    return (listStmt.all(term, term, term, term, term, term) as any[]).map(s => ({
      ...s, tags: parse(s.tags, []), topic: t.get(s.id) ?? "uncategorized", latestJob: latestJobStmt.get(s.id) ?? null
    }));
  });

  app.get("/skills/:id", async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: "Invalid skill id" });
    const q = z.object({ version: z.coerce.number().int().min(1).optional() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Invalid version" });
    const s = skillStmt.get(p.data.id) as any;
    if (!s) return reply.code(404).send({ error: "Skill not found" });
    const viewVersion = q.data.version ?? s.version;
    const v = viewVersion ? versionStmt.get(s.id, viewVersion) as any : null;
    if (q.data.version && !v) return reply.code(404).send({ error: "Version not found" });
    return {
      skill: { id: s.id, idea_id: s.idea_id, title: s.title, status: s.status, summary: s.summary, tags: parse(s.tags, []), version: s.version,
        error: s.error, created_at: s.created_at, updated_at: s.updated_at, topic: topics().get(s.id) ?? "uncategorized" },
      idea: { id: s.idea_id, title: s.idea_title },
      viewVersion: v ? v.version : null,
      summary: v?.summary ?? null,
      tags: v ? parse(v.tags, []) : [],
      sections: v ? parse(v.sections, []) : [],
      stats: v ? parse(v.stats, null) : null,
      findings: v ? (findingsStmt.all(s.id, v.version) as Array<{ url: string }>).map(withType) : [],
      sources: v ? (sourcesStmt.all(s.id, v.version) as Array<{ url: string; cited: number }>).map(x => withType({ ...x, cited: !!x.cited })) : [],
      versions: (versionsStmt.all(s.id) as any[]).map(x => {
        const st = parse(x.stats, {}) as any;
        return { version: x.version, job_id: x.job_id, created_at: x.created_at, verifiedFacts: st.verifiedFacts ?? null, total_ms: st.total_ms ?? null };
      }),
      latestJob: latestJobStmt.get(s.id) ?? null
    };
  });
}
