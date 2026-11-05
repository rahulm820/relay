import { dummyPasswordHash, verifyPassword } from "@relay/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Authenticator } from "./auth.js";
import { LoginThrottle, clearedCookie, hashToken, newToken, readSessionToken, sessionCookie, type AuthStore } from "./session.js";

export interface AuthRouteDeps {
  store: AuthStore;
  authenticate: Authenticator;
  throttle: LoginThrottle;
  sessionTtlHours: number;
  cookieSecure: boolean;
}

const LoginBody = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) }).strict();

/**
 * POST /api/auth/login   {email, password} -> 200 {user, tenant}  + Set-Cookie (no token in the body)
 * POST /api/auth/logout                    -> 204, session revoked on the server, cookie cleared
 * GET  /api/auth/me                        -> 200 {user, tenant} or 401
 *
 * Login answers every failure (unknown email, wrong password, disabled account) with the same 401 body, and spends
 * the same scrypt work in every case. Failures are throttled per address and per submitted email.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const ttlSeconds = deps.sessionTtlHours * 3600;

  app.post("/api/auth/login", async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "validation_error", message: "email and password are required" });
    const { email, password } = body.data;

    const wait = deps.throttle.check(req.ip, email);
    if (wait > 0) return reply.code(429).header("retry-after", String(wait)).send({ error: "too_many_attempts", message: "try again later" });

    const candidate = await deps.store.findAdmin(email);
    // verifyPassword hashes against a dummy when there is no stored hash, so unknown accounts cost the same.
    const passwordOk = await verifyPassword(password, candidate?.passwordHash ?? (await dummyPasswordHash()));
    if (!candidate || !passwordOk || !candidate.active) {
      deps.throttle.fail(req.ip, email);
      return reply.code(401).send({ error: "invalid_credentials", message: "invalid email or password" });
    }
    deps.throttle.clear(email);

    // Rotation: a new token every login, and a session presented with this request is ended.
    const previous = readSessionToken(req.headers.cookie);
    if (previous) await deps.store.revoke(candidate.tenantId, hashToken(previous));
    const token = newToken();
    await deps.store.createSession(candidate.tenantId, candidate.id, hashToken(token), ttlSeconds);
    await deps.store.audit(candidate.tenantId, `user:${candidate.id}`, "auth.login");

    const me = await describe(deps, candidate.tenantId, candidate.id, email, candidate.role, candidate.name);
    return reply.code(200).header("set-cookie", sessionCookie(token, ttlSeconds, deps.cookieSecure)).header("cache-control", "no-store").send(me);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = readSessionToken(req.headers.cookie);
    if (token) {
      const principal = await deps.authenticate(req);
      if (principal) {
        await deps.store.revoke(principal.tenantId, hashToken(token));
        await deps.store.audit(principal.tenantId, `user:${principal.userId}`, "auth.logout");
      }
    }
    return reply.code(204).header("set-cookie", clearedCookie(deps.cookieSecure)).send();
  });

  app.get("/api/auth/me", async (req: FastifyRequest, reply) => {
    const principal = await deps.authenticate(req);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    return reply.header("cache-control", "no-store").send(await describe(deps, principal.tenantId, principal.userId, principal.email, principal.role, principal.name));
  });
}

async function describe(deps: AuthRouteDeps, tenantId: string, userId: string, email: string, role: string, name: string) {
  return { user: { id: userId, email: email.toLowerCase(), name, role }, tenant: { id: tenantId, name: await deps.store.tenantName(tenantId) } };
}
