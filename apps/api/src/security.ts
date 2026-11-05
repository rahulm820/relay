import type { FastifyInstance } from "fastify";

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "relay-admin";

/**
 * Browser-facing protections for everything under /api:
 *  - CORS: only the listed origins, with credentials, never a wildcard. Anything else gets no CORS headers, so the
 *    browser refuses to hand the response to the page.
 *  - CSRF: every state-changing request must carry `X-Requested-With: relay-admin` (a header a cross-site form or
 *    image cannot add, and a cross-origin script cannot add without a CORS preflight we only grant to listed
 *    origins), and if the browser says where the request came from (`Origin`), that origin must be listed.
 *    Safe methods (GET/HEAD) are never state-changing here.
 */
export function registerApiSecurity(app: FastifyInstance, o: { allowedOrigins: string[] }): void {
  const allowed = new Set(o.allowedOrigins);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const origin = req.headers.origin;
    const originAllowed = typeof origin === "string" && allowed.has(origin);
    if (originAllowed) {
      void reply.header("access-control-allow-origin", origin).header("access-control-allow-credentials", "true").header("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!originAllowed) return reply.code(403).send({ error: "forbidden" });
      return reply.code(204)
        .header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE")
        .header("access-control-allow-headers", "content-type, x-requested-with")
        .header("access-control-max-age", "600")
        .send();
    }
    if (req.method === "GET" || req.method === "HEAD") return;
    if (req.headers[CSRF_HEADER] !== CSRF_VALUE || (typeof origin === "string" && !originAllowed)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }
  });
}
