// An in-memory AuthStore with a controllable clock, so session expiry and login behaviour can be tested without a
// database. Test-only. It mirrors what relay_resolve_session enforces in Postgres.
import type { LoginCandidate, ResolvedSession } from "@relay/db";
import { hashPassword } from "@relay/shared";
import type { AuthStore } from "../session.js";

interface Row { sessionId: string; tenantId: string; userId: string; hash: string; createdAt: number; lastSeen: number; expiresAt: number; revoked: boolean }

export class MemoryAuthStore implements AuthStore {
  time = Date.parse("2026-11-05T09:00:00Z");
  readonly users = new Map<string, LoginCandidate & { email: string }>();
  readonly sessions: Row[] = [];
  readonly audits: { tenantId: string; actor: string; action: string }[] = [];
  private n = 0;

  async addUser(email: string, password: string, over: Partial<LoginCandidate> = {}): Promise<LoginCandidate> {
    const u = { id: `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`, tenantId: "00000000-0000-4000-8000-0000000000t1".replace("t1", "01"), passwordHash: await hashPassword(password, { N: 1024, r: 8, p: 1 }), role: "pm", active: true, name: "Admin", email: email.toLowerCase(), ...over };
    this.users.set(u.email, u);
    return u;
  }
  advance(ms: number): void { this.time += ms; }

  async findAdmin(email: string) { return this.users.get(email.trim().toLowerCase()) ?? null; }
  async createSession(tenantId: string, userId: string, tokenHash: string, ttlSeconds: number) {
    this.sessions.push({ sessionId: `s${this.sessions.length}`, tenantId, userId, hash: tokenHash, createdAt: this.time, lastSeen: this.time, expiresAt: this.time + ttlSeconds * 1000, revoked: false });
  }
  async resolve(tokenHash: string, idleSeconds: number): Promise<ResolvedSession | null> {
    const s = this.sessions.find((r) => r.hash === tokenHash);
    if (!s || s.revoked || s.expiresAt <= this.time || s.lastSeen <= this.time - idleSeconds * 1000) return null;
    const u = [...this.users.values()].find((x) => x.id === s.userId);
    if (!u || !u.active) return null;
    s.lastSeen = this.time;
    return { sessionId: s.sessionId, tenantId: s.tenantId, userId: u.id, email: u.email, name: u.name, role: u.role };
  }
  async revoke(_tenantId: string, tokenHash: string) { for (const s of this.sessions) if (s.hash === tokenHash) s.revoked = true; }
  async audit(tenantId: string, actor: string, action: string) { this.audits.push({ tenantId, actor, action }); }
  async tenantName() { return "Demo Co"; }
}
