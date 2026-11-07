# Relay — Client Complaint Automation

Client complaints in (Telegram), triaged tickets out: LLM classification,
priority/routing, GitHub issues (general sync + code-aware drafts with human
approval), a Switch room per ticket, and a status loop back to the client.

## Architecture (30 seconds)

```
Telegram ──webhook──▶ platform-api ──Redis Streams──▶ platform-worker
                        │                                  ├─ LLM extract → dedupe → priority → ticket
                        │                                  ├─ GitHub issue (outbox, retried)
                        │                                  ├─ Switch room + kickoff (outbox)
                        │                                  └─ ack / status update → Telegram
                        └─ Postgres (RLS per tenant) + Redis queue
frontend (Next.js) ──/api──▶ platform-api     Switch (gateway+Mattermost) ◀── worker
```

- `apps/api` — HTTP API (auth, tickets, admin, Telegram webhook).
- `apps/worker` — queue consumers, outbox dispatcher, GitHub reconcile job.
- `apps/web` — admin UI: ticket board + Setup walkthrough (`/admin`).
- `packages/*` — shared types/config, db (schema/RLS/migrations/seed),
  trackers (GitHub), llm (Gemini/Anthropic/Ollama), channels (Telegram),
  switch (rooms/agents), core (orchestrator/outbox), e2e (demo test).
- `seed/demo-app` — tiny checkout app with a known 500 bug (the demo complaint).

## How Switch is used

Switch is the team-chat layer. Relay never talks to Mattermost/Slack directly:

- **Rooms**: one room per ticket, named `relay-<first 8 hex of ticket id>`,
  description carries `relay:ticket:<uuid>` as the recovery marker. Created by
  the worker's `switch.create_room` outbox handler (idempotent: advisory lock +
  lookup by marker + stored `switch_room_ref`).
- **Agents** (see `seed/switch-agents/`): `relay-triager` (summarises/routes in
  the room) and `relay-notifier` (posts the kickoff + pings the owner). The
  notifier's API key is issued once at bootstrap, stored in git-ignored
  `.env.switch` (mode 600), and is the only key Relay keeps — only it posts.
- **Permissions**: agents can post/mention in ticket rooms only. Raw client
  text is never sent to Switch — kickoff uses sanitised title/summary
  (`sanitizeUntrusted`: no mentions/links/markup), never credentials.
- **Bridge**: with Switch's default bridge running, rooms appear as channels
  in Mattermost; without it, rooms exist inside Switch only (bootstrap warns).
- **Setup**: run Switch from its checkout (`/home/rahul/switch`), then
  `npm run switch:bootstrap -w @relay/switch` (idempotent), load `.env.switch`,
  set `SWITCH_*` in `.env`, restart the worker. Verify with
  `npm run switch:smoke -w @relay/switch`.

## Setup (clean machine)

```bash
cp .env.example .env        # fill MESSAGE_ENCRYPTION_KEY (openssl rand -base64 32),
                            # ADMIN_EMAIL/ADMIN_PASSWORD, provider keys (see table)
docker compose up -d --build
npm install
npm run db:migrate -w @relay/db
ADMIN_EMAIL=admin@demo.local ADMIN_PASSWORD=Demo1234! npm run db:seed -w @relay/db
```

Open http://localhost:3000/login (seeded admin), then `/admin` (Setup link).
The seed creates: Demo Co tenant, Telegram bot (pending), GitHub integration
(`relay/demo-app`, human approval, code-aware), 4 members, 3 routing rules,
SLAs, and one open P1 ticket — the board is populated on first login.

### Required env (`.env`, never commit)

| Var | Required | What |
|---|---|---|
| `MESSAGE_ENCRYPTION_KEY` | yes | AES-256-GCM key for message text at rest |
| `DATABASE_URL` / `DATABASE_ADMIN_URL` | yes | app login / schema owner (migrate+seed only) |
| `REDIS_URL` | yes | queue |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | seed | first admin (pm) |
| `TELEGRAM_BOT_TOKEN` | Telegram | BotFather token (`env:TELEGRAM_BOT_TOKEN` ref) |
| `TELEGRAM_WEBHOOK_PUBLIC_URL` | Telegram | public HTTPS base for webhooks (tunnel) |
| `GITHUB_TOKEN` | GitHub | `issues:write` + `metadata:read` |
| `LLM_API_KEY` + `LLM_FAST_MODEL` (+ `LLM_STRONG_MODEL`) | LLM | Gemini default; without it, complaints become P3 quarantine tickets |
| `SWITCH_GATEWAY_URL` / `SWITCH_ADMIN_EMAIL` / `SWITCH_ADMIN_PASSWORD` / `SWITCH_NOTIFIER_API_KEY` | Switch | see Switch section |
| `RELAY_API_URL` | web | API base for the Next proxy (compose overrides to `http://api:8080`) |

Providers are referenced in the DB only as `env:NAME`; raw values live in
`.env` locally. Production path: secret manager (not built here).

## Connect providers (from the UI, `/admin`)

1. **Telegram**: BotFather → token in `.env` → HTTPS tunnel → Bots → Register
   bot → `npm run telegram:register -w @relay/channels -- --bot-id <id>`.
2. **GitHub**: token in `.env` → Integrations → Connect GitHub
   (`owner/repo`, approval `human`, code-aware on).
3. **LLM**: keys in `.env`, restart worker.
4. **Switch**: bootstrap + smoke (above), restart worker.

## Demo (3 minutes)

```bash
./demo.sh            # checks stack + seed, then prints the story steps
```

Story: message the bot *"my checkout fails with 500 when I tap Pay now"*
(`seed/demo-app` reproduces it: `node seed/demo-app/server.js` →
`curl -X POST localhost:4000/pay` → 500) → ticket on the board → GitHub issue
→ code-aware draft approved in Issue drafts → Switch room `relay-*` in
Mattermost → ack + status updates back in Telegram. Offline equivalent
(all externals mocked, real pipeline): `TEST_ADMIN_URL=... TEST_REDIS_URL=...
npm run test -w @relay/e2e` (`demo-path` suite).

## Stretch (not built)

WhatsApp/Teams/Discord/Jira/Linear adapters — schema enums exist, no
providers. Auto-approved code-aware issues — approval stays `human` by design.

## Testing

`npm test` (Compose test env: Postgres+Redis, built packages, per-workspace
suites + e2e). See `docs/testing.md`.
