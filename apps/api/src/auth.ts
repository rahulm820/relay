import type { Actor } from "@relay/core";
import type { Role } from "@relay/shared";
import type { FastifyRequest } from "fastify";

/** The verified caller. The tenant comes from the server-side session and nowhere else: never body, header or query. */
export interface Principal {
  tenantId: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  actor: Actor;
}

/** Resolves the caller of a request, or null if it cannot be authenticated. Must not trust anything the client chooses. */
export type Authenticator = (req: FastifyRequest) => Promise<Principal | null>;

/** Authenticates nobody. Used by tests that need a route to answer 401. */
export const denyAll: Authenticator = async () => null;
