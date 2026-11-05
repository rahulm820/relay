import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  ACTOR_TYPES, APPROVAL_POLICIES, BOT_STATUSES, CATEGORIES, CHANNELS, CHAT_PROVIDERS, CLIENT_TIERS,
  CONVERSATION_STATUSES, DRAFT_STATUSES, INTEGRATION_STATUSES, MESSAGE_DIRECTIONS, OUTBOX_KINDS,
  OUTBOX_STATUSES, PRIORITIES, PRIORITY_SOURCES, ROLES, SYNC_MODES, SYNC_STATUSES, TICKET_STATUSES,
  TRACKER_PROVIDERS,
} from "@relay/shared";
import { SEED_COUNTS, DEMO_TENANT_ID, createPool, listDueOutbox, migrateDown, migrateUp, resolveBotTenant, seed, setRolePasswords, withTenant, type Pool } from "./index.js";

// Needs Relay's own Postgres: `docker compose up -d postgres` (host port 5433). Throwaway DB, dropped at the end.
const ADMIN = process.env["TEST_ADMIN_URL"] ?? "postgres://relay:change-me@localhost:5433/postgres";
const DB = `relay_test_${process.pid}`;
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

let maint: pg.Client;
let owner: Pool;
let api: Pool;
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

before(async () => {
  maint = new pg.Client({ connectionString: ADMIN });
  await maint.connect();
  await maint.query(`CREATE DATABASE ${DB}`);
  owner = createPool(withDb(ADMIN, DB));
  await migrateUp(owner);
  await setRolePasswords(owner, { relay_api: "test-api-pw" });
  const u = new URL(withDb(ADMIN, DB)); u.username = "relay_api"; u.password = "test-api-pw";
  api = createPool(u.toString());
});

after(async () => {
  await api?.end();
  await owner?.end();
  await maint.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await maint.end();
});

const count = async (pool: Pool, table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe("migrations", () => {
  it("re-running up is a no-op", async () => {
    assert.deepEqual(await migrateUp(owner), []);
  });

  it("enum types match @relay/shared", async () => {
    const expected: Record<string, readonly string[]> = {
      category: CATEGORIES, priority: PRIORITIES, priority_source: PRIORITY_SOURCES, ticket_status: TICKET_STATUSES,
      role: ROLES, client_tier: CLIENT_TIERS, channel: CHANNELS, actor_type: ACTOR_TYPES, approval_policy: APPROVAL_POLICIES,
      sync_mode: SYNC_MODES, sync_status: SYNC_STATUSES, outbox_kind: OUTBOX_KINDS, outbox_status: OUTBOX_STATUSES,
      bot_status: BOT_STATUSES, integration_status: INTEGRATION_STATUSES, draft_status: DRAFT_STATUSES,
      message_direction: MESSAGE_DIRECTIONS, chat_provider: CHAT_PROVIDERS, tracker_provider: TRACKER_PROVIDERS,
      conversation_status: CONVERSATION_STATUSES,
    };
    for (const [type, values] of Object.entries(expected)) {
      const { rows } = await owner.query("SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder", [type]);
      assert.deepEqual(rows.map((r) => r.enumlabel), [...values], type);
    }
  });

  it("down reverses everything and up works again", async () => {
    const throwaway = `${DB}_down`;
    await maint.query(`CREATE DATABASE ${throwaway}`);
    const p = createPool(withDb(ADMIN, throwaway));
    try {
      await migrateUp(p);
      assert.equal((await migrateDown(p, 99)).length, 5);
      const { rows } = await p.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'");
      assert.equal(rows[0].n, 0);
      assert.equal((await p.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'")).rows[0].n, 0);
      assert.equal((await migrateUp(p)).length, 5);
    } finally {
      await p.end();
      await maint.query(`DROP DATABASE ${throwaway} WITH (FORCE)`);
    }
  });
});

describe("seed", () => {
  it("is idempotent", async () => {
    await seed(owner);
    const first = await Promise.all(Object.keys(SEED_COUNTS).map((t) => count(owner, t)));
    await seed(owner);
    const second = await Promise.all(Object.keys(SEED_COUNTS).map((t) => count(owner, t)));
    assert.deepEqual(first, Object.values(SEED_COUNTS));
    assert.deepEqual(second, first);
  });

  it("members cover every role", async () => {
    const { rows } = await owner.query("SELECT DISTINCT role FROM members WHERE tenant_id = $1 ORDER BY role", [DEMO_TENANT_ID]);
    assert.deepEqual(rows.map((r) => r.role).sort(), [...ROLES].sort());
  });
});

describe("row-level security", () => {
  let ticketB: string;

  before(async () => {
    await owner.query("INSERT INTO tenants (id, name) VALUES ($1,'A'),($2,'B') ON CONFLICT DO NOTHING", [T1, T2]);
    ticketB = (await withTenant(api, T2, async (c) =>
      (await c.query("INSERT INTO tickets (tenant_id, title, category, priority) VALUES ($1,'b-secret','bug','P1') RETURNING id", [T2])).rows[0].id)) as string;
    await withTenant(api, T1, (c) => c.query("INSERT INTO tickets (tenant_id, title, category, priority) VALUES ($1,'a-ticket','bug','P2')", [T1]));
  });

  it("the app role is neither superuser, table owner nor BYPASSRLS", async () => {
    const { rows } = await api.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    assert.equal(rows[0].rolsuper, false);
    assert.equal(rows[0].rolbypassrls, false);
    const own = await api.query("SELECT tableowner FROM pg_tables WHERE tablename = 'tickets'");
    assert.notEqual(own.rows[0].tableowner, "relay_api");
  });

  it("no tenant context returns zero rows", async () => {
    assert.equal(await count(api, "tickets"), 0);
    assert.equal(await count(api, "tenants"), 0);
  });

  it("each tenant sees only its own rows", async () => {
    const a = await withTenant(api, T1, (c) => c.query("SELECT title FROM tickets"));
    assert.deepEqual(a.rows.map((r) => r.title), ["a-ticket"]);
  });

  it("wrong tenant context cannot read, update or delete another tenant's ticket", async () => {
    await withTenant(api, T1, async (c) => {
      assert.equal((await c.query("SELECT 1 FROM tickets WHERE id = $1", [ticketB])).rowCount, 0);
      assert.equal((await c.query("UPDATE tickets SET title = 'pwned' WHERE id = $1", [ticketB])).rowCount, 0);
      assert.equal((await c.query("DELETE FROM tickets WHERE id = $1", [ticketB])).rowCount, 0);
    });
    const { rows } = await owner.query("SELECT title FROM tickets WHERE id = $1", [ticketB]);
    assert.equal(rows[0].title, "b-secret");
  });

  it("cannot write a row for another tenant", async () => {
    await assert.rejects(
      withTenant(api, T1, (c) => c.query("INSERT INTO tickets (tenant_id, title, category, priority) VALUES ($1,'x','bug','P1')", [T2])),
      /row-level security/,
    );
  });

  it("tenant context does not leak across pooled connections", async () => {
    await withTenant(api, T1, (c) => c.query("SELECT 1"));
    assert.equal(await count(api, "tickets"), 0);
  });

  it("ticket_events is append-only for the app role", async () => {
    await withTenant(api, T1, async (c) => {
      const t = (await c.query("SELECT id FROM tickets")).rows[0].id;
      await c.query("INSERT INTO ticket_events (tenant_id, ticket_id, type, actor_type) VALUES ($1,$2,'created','system')", [T1, t]);
    });
    await assert.rejects(withTenant(api, T1, (c) => c.query("UPDATE ticket_events SET type = 'x'")), /permission denied/);
    await assert.rejects(withTenant(api, T1, (c) => c.query("DELETE FROM ticket_events")), /permission denied/);
  });

  it("resolveBotTenant and listDueOutbox work without a tenant context", async () => {
    assert.equal(await resolveBotTenant(api, "00000000-0000-4000-8000-000000000101"), DEMO_TENANT_ID);
    assert.equal(await resolveBotTenant(api, "99999999-9999-4999-8999-999999999999"), null);
    await withTenant(api, T1, (c) => c.query("INSERT INTO outbox (tenant_id, kind, idempotency_key) VALUES ($1,'client.send','due-1')", [T1]));
    const due = await listDueOutbox(api, 10);
    assert.deepEqual(due.map((d) => d.tenantId), [T1]);
  });

  it("withTenant rejects a non-UUID tenant id", async () => {
    await assert.rejects(withTenant(api, "1; DROP TABLE tickets", async () => 1), /UUID/);
  });
});

describe("uniqueness and pgvector", () => {
  it("duplicate outbox and tracker_issues idempotency keys are rejected", async () => {
    await withTenant(api, T1, async (c) => {
      const t = (await c.query("SELECT id FROM tickets")).rows[0].id;
      await c.query("INSERT INTO tracker_issues (tenant_id, ticket_id, provider, idempotency_key) VALUES ($1,$2,'github','k1')", [T1, t]);
      await c.query("SAVEPOINT s");
      await assert.rejects(c.query("INSERT INTO tracker_issues (tenant_id, ticket_id, provider, idempotency_key) VALUES ($1,$2,'github','k1')", [T1, t]), /duplicate key/);
      await c.query("ROLLBACK TO s");
      await c.query("INSERT INTO outbox (tenant_id, kind, idempotency_key) VALUES ($1,'github.create_issue','o1')", [T1]);
      await c.query("SAVEPOINT s2");
      await assert.rejects(c.query("INSERT INTO outbox (tenant_id, kind, idempotency_key) VALUES ($1,'github.create_issue','o1')", [T1]), /duplicate key/);
    });
  });

  it("vector insert and cosine query work", async () => {
    const vec = (i: number) => `[${Array.from({ length: 1024 }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;
    await withTenant(api, T1, async (c) => {
      await c.query("INSERT INTO tickets (tenant_id, title, category, priority, embedding) VALUES ($1,'v0','bug','P3',$2),($1,'v1','bug','P3',$3)", [T1, vec(0), vec(1)]);
      const { rows } = await c.query("SELECT title FROM tickets WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT 1", [vec(1)]);
      assert.equal(rows[0].title, "v1");
    });
  });
});
