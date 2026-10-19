// Cross-site request protection for the local API.
// State-changing methods (anything but GET/HEAD/OPTIONS) are refused with 403 when a browser marks them
// as cross-site, or when an Origin header is present and is not the API's own origin.
// Requests without Origin (curl, scripts, workers) are allowed. A non-empty body must be application/json (415).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1:3333", "http://localhost:3333"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type GuardDecision = { ok: true } | { ok: false; code: 403 | 415; error: string };

export function checkRequest(
  method: string, headers: Record<string, string | string[] | undefined>, allowed: string[] = DEFAULT_ALLOWED_ORIGINS
): GuardDecision {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const site = h("sec-fetch-site");
  if (site && site.toLowerCase() === "cross-site") return { ok: false, code: 403, error: "Cross-site request refused" };
  const origin = h("origin");
  if (origin !== undefined && !allowed.includes(origin)) return { ok: false, code: 403, error: "Origin not allowed" };
  const length = Number(h("content-length") ?? 0);
  const hasBody = length > 0 || h("transfer-encoding") !== undefined;
  const type = (h("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (hasBody && type !== "application/json") return { ok: false, code: 415, error: "Request body must be application/json" };
  return { ok: true };
}

/** Adds the guard as an onRequest hook on this instance (call on the root app so it covers every route). */
export function addCrossSiteGuard(app: FastifyInstance, allowed: string[] = DEFAULT_ALLOWED_ORIGINS) {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const d = checkRequest(request.method, request.headers, allowed);
    if (!d.ok) {
      request.log.warn({ method: request.method, url: request.url, origin: request.headers.origin }, d.error);
      return reply.code(d.code).send({ error: d.error });
    }
  });
}
