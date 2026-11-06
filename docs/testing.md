# Testing

`npm test` runs everything against a clean, throwaway Postgres (with pgvector) and Redis. Nothing talks to the internet:
Telegram, the LLM, GitHub and Switch are all local mocks.

```
npm test                      # the whole suite (needs Docker, or your own Postgres + Redis, see below)
npm test -- --only=shared,core   # just these workspaces
npm test -- --keep            # leave the test containers running afterwards
npm test -- --no-build        # skip the build step if the packages are already built
npm run test:golden           # golden-set extraction smoke check on its own
npm run test:env:up / :down   # start or stop the test containers yourself
```

`npm test` starts `docker-compose.test.yml` (Postgres on 127.0.0.1:5434, Redis on 127.0.0.1:6380, data in memory so every
run starts empty), builds the server packages, runs each workspace's tests and prints one summary table, runs the
golden-set smoke check, then removes the containers, even after a failure or Ctrl-C.

**Using your own services** (for example CI service containers): set `TEST_ADMIN_URL` (a Postgres superuser URL on the
`postgres` database, e.g. `postgres://relay:pw@127.0.0.1:5434/postgres`) and `TEST_REDIS_URL`. The runner then skips Docker.
Every suite creates its own throwaway database, so a shared server is fine.

## The layers

| Layer | Where | What it proves | Needs |
|---|---|---|---|
| Unit | `packages/*/src/*.test.ts`, `apps/web/src/lib` | Pure logic: config, schemas, redaction, state machine, backoff, priority, idempotency keys, SLA maths | nothing |
| Component integration | `packages/*` DB tests | One package against real Postgres/Redis: queue, outbox, tickets, reconcile store, row-level security | Postgres, Redis |
| Integration | `packages/e2e/src/reconcile.integration.test.ts` | The GitHub sync stage and reconcile job against real Postgres and an HTTP mock GitHub, with a movable clock: outage, dropped connection, rate limit, drift | Postgres |
| End to end | `packages/e2e/src/demo-path.e2e.test.ts` | The real API and worker processes (built `dist`): complaint in, classified, ticket, GitHub issue, Switch room, ack, status update back to the client; duplicates; outages | Postgres, Redis, built packages |
| Golden set | `packages/llm/golden`, `npm run test:golden` | Category accuracy and false-duplicate rate of the real model. A measurement: skipped without `LLM_*`, never fails the run | an LLM key (optional) |

## How the E2E suite stays offline and deterministic

- The API and worker run unmodified. A preload shim (`packages/e2e/src/preload/network-boundary.mjs`) redirects
  `api.github.com`, `api.telegram.org` and the Gemini host to local mocks and **refuses every other non-loopback host**
  (the refusal is logged; a test asserts there were none). A real GitHub issue can therefore never be created by a test.
- Tests wait for state (polling the database or a mock), never a fixed delay. "Did not happen" is proved with a barrier:
  a later message from the same client is processed after the earlier work, so once it is answered nothing earlier can
  still be in flight.
- The reconcile suite moves the clock by rewriting timestamps instead of sleeping.

Mocks (all test-only, in `src/testing/` of their package and exported as `@relay/<pkg>/testing`): `MockTelegram`,
`MockSwitch`, `MockGitHub` (issues, search with optional index lag, rate limits, accepted-then-dropped creates), plus the
scripted `MockGemini` in the e2e package. `MockGitHub` has its own tests through the real `GitHubProvider`.

## Not covered yet

- Priority/routing engine (#10) and duplicate detection (#11) are not implemented, so only the provisional priority rule
  has unit tests and the golden set reports the false-duplicate rate as `n/a`. The golden set already contains labelled
  duplicate pairs; plug a detector into `runGolden` when #11 lands.
- Live checks against the real GitHub, Telegram, Switch and a real model are manual and gated; none run by default.
