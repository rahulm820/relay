import { createHash, randomBytes } from "node:crypto";
import type { LoginCandidate, ResolvedSession } from "@relay/db";
import type { Role } from "@relay/shared";
import type { FastifyRequest } from "fastify";
import type { Authenticator } from "./auth.js";

export const COOKIE_NAME = "relay_session";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes as base64url

/** 32 random bytes. The raw token lives only in the browser cookie; the server stores its SHA-256. */
export const newToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export function readSessionToken(cookieHeader: string | undefined): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const value = rest.join("=");
      return TOKEN_SHAPE.test(value) ? value : null;
    }
  }
  return null;
}

/**
 * HttpOnly (script cannot read it), SameSite=Lax (sent on same-site requests such as the admin UI on another port of
 * the same host, not on cross-site POSTs), Path=/api (only the API sees it), Secure outside local development.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAgeSeconds}; Path=/api; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
export const clearedCookie = (secure: boolean): string => `${COOKIE_NAME}=; Max-Age=0; Path=/api; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;

/** What the auth routes and the session authenticator need from storage (Postgres in production, memory in tests). */
export interface AuthStore {
  findAdmin(email: string): Promise<LoginCandidate | null>;
  createSession(tenantId: string, userId: string, tokenHash: string, ttlSeconds: number): Promise<void>;
  /** The live session for this token hash (not revoked, not expired, not idle too long), marking it used. */
  resolve(tokenHash: string, idleSeconds: number): Promise<ResolvedSession | null>;
  revoke(tenantId: string, tokenHash: string): Promise<void>;
  audit(tenantId: string, actor: string, action: string): Promise<void>;
  tenantName(tenantId: string): Promise<string | null>;
}

/** Turns the session cookie into a Principal. Anything malformed, unknown, revoked or expired is simply "not signed in". */
export function sessionAuthenticator(store: AuthStore, idleSeconds: number): Authenticator {
  return async (req: FastifyRequest) => {
    const token = readSessionToken(req.headers.cookie);
    if (!token) return null;
    const s = await store.resolve(hashToken(token), idleSeconds);
    if (!s) return null;
    return {
      tenantId: s.tenantId, userId: s.userId, email: s.email, name: s.name, role: s.role as Role,
      actor: { type: "human", ref: `user:${s.userId}` },
    };
  };
}

/**
 * Failed-login limiter, in memory (resets on restart; one process). Counts failures per client address and per
 * submitted email, whether or not that email exists, so the limiter reveals nothing about accounts.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly o: { maxPerAccount?: number; maxPerIp?: number; windowMs?: number; now?: () => number } = {}) {}

  private get now() { return (this.o.now ?? Date.now)(); }
  private get window() { return this.o.windowMs ?? 15 * 60_000; }

  private recent(key: string): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => t > this.now - this.window);
    if (list.length) this.failures.set(key, list); else this.failures.delete(key);
    return list;
  }

  /** Seconds to wait if blocked, otherwise 0. */
  check(ip: string, email: string): number {
    const limits: [string, number][] = [[`acct:${email.trim().toLowerCase()}`, this.o.maxPerAccount ?? 5], [`ip:${ip}`, this.o.maxPerIp ?? 20]];
    let wait = 0;
    for (const [key, max] of limits) {
      const list = this.recent(key);
      if (list.length >= max) wait = Math.max(wait, Math.ceil((list[0]! + this.window - this.now) / 1000));
    }
    return wait;
  }

  fail(ip: string, email: string): void {
    for (const key of [`acct:${email.trim().toLowerCase()}`, `ip:${ip}`]) this.failures.set(key, [...this.recent(key), this.now]);
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!); // bound memory
  }

  /** A successful login clears the account's failures (not the address's). */
  clear(email: string): void { this.failures.delete(`acct:${email.trim().toLowerCase()}`); }
}
