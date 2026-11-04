import type { Actor } from "@relay/core";
import type { FastifyRequest } from "fastify";

/** The verified caller. The tenant comes from here and nowhere else: never from a body, header or query. */
export interface Principal {
  tenantId: string;
  actor: Actor;
}

/**
 * Resolves the caller of a request, or null if it cannot be authenticated. Issue #17 supplies the real
 * implementation (session -> user -> tenant). Implementations must not trust anything the client can choose.
 */
export type Authenticator = (req: FastifyRequest) => Promise<Principal | null>;

/** The default: nobody is authenticated, so the ticket routes answer 401 until something is plugged in. */
export const denyAll: Authenticator = async () => null;

/** LOCAL DEVELOPMENT ONLY (DEV_AUTH_ENABLED): every caller is one fixed tenant. Never use in production. */
export const devAuthenticator = (tenantId: string): Authenticator => async () => ({ tenantId, actor: { type: "human", ref: "dev" } });
