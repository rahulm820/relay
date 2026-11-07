#!/usr/bin/env bash
# Relay demo runbook — the 3-minute story: complaint → ticket → GitHub issue →
# code-aware draft approved → Switch room → client reply.
# Usage: ./demo.sh [--check]   (--check = verify stack+seed only, no story)
set -euo pipefail
cd "$(dirname "$0")"

API="${RELAY_API_URL:-http://localhost:8080}"
WEB="${RELAY_WEB_URL:-http://localhost:3001}"
step() { printf '\n=== %s ===\n' "$*"; }

step "1/6 Stack health"
curl -sf "$API/healthz" && echo " api ok"
curl -sf "http://localhost:8091/healthz" >/dev/null && echo " worker ok" || echo " worker: not on :8091 (docker compose port)"

step "2/6 Sign in + open the board"
echo " Open $WEB/login (admin@demo.local / Demo1234!) then $WEB/admin for the setup checklist."

step "3/6 Known bug (seed/demo-app)"
echo " node seed/demo-app/server.js  # then: curl -X POST http://localhost:4000/pay -> 500"

step "4/6 Complaint → ticket → GitHub issue → Switch room → client reply"
cat <<'STORY'
 Message the Telegram bot (or POST a signed update to /webhooks/telegram/:botId):
   "Hi, my checkout fails with an error 500 when I tap Pay now. You can reach me at jane.doe@example.com"
 Watch: ticket board → GitHub issue in relay/demo-app → Switch room relay-* in Mattermost → ack in chat.
STORY

step "5/6 Code-aware draft"
echo " With approval_policy=human: approve the draft in Issue drafts; the issue link appears on the ticket."

step "6/6 Status loop"
echo " Move the ticket (board) → client gets the status update in Telegram."

if [ "${1:-}" = "--check" ]; then echo; echo "Check passed. Full story needs Telegram/GitHub/LLM keys (see README)."; fi
echo; echo "Offline equivalent (mocked externals, real pipeline):"
echo "  TEST_ADMIN_URL=postgres://relay:<pw>@127.0.0.1:5434/postgres TEST_REDIS_URL=redis://127.0.0.1:6380 npm run test -w @relay/e2e"
