"use client";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { AdminBots } from "../../components/admin-bots";
import { AdminChatConnections } from "../../components/admin-chat-connections";
import { AdminIntegrations } from "../../components/admin-integrations";
import { AdminRoutingRules } from "../../components/admin-routing-rules";
import { AdminTeamRoles } from "../../components/admin-team-roles";
import { Button } from "../../components/ui";
import { toast } from "sonner";

interface Status { bots: number; activeBots: number; integrations: number; members: number; rules: number; failed: number; backlogAge: number }

const STEPS = [
  { n: 1, t: "Telegram bot", d: "BotFather → /newbot → paste token in server .env as TELEGRAM_BOT_TOKEN → expose API via HTTPS tunnel (TELEGRAM_WEBHOOK_PUBLIC_URL) → register: npm run telegram:register -w @relay/channels -- --bot-id <id> → bot status becomes active → message the bot." },
  { n: 2, t: "GitHub", d: "Create token (issues:write) → GITHUB_TOKEN in server .env → connect below (repo owner/name, approval human to demo drafts, label map JSON)." },
  { n: 3, t: "LLM", d: "Set LLM_API_KEY + LLM_FAST_MODEL (+ LLM_STRONG_MODEL for drafts, LLM_EMBED_MODEL for dedupe) in server .env, restart worker. Without it, complaints become P3 quarantine tickets (nothing is lost)." },
  { n: 4, t: "Switch (team chat)", d: "Switch already runs locally (gateway :8000, Mattermost :8065). Run npm run switch:bootstrap -w @relay/switch with SWITCH_ADMIN_* from switch/.env, load .env.switch, set SWITCH_* in .env, restart worker. Each ticket then gets a relay-<id> room in Mattermost." },
  { n: 5, t: "Team & routing", d: "Add members with chat handles (Switch usernames) and routing rules below. Seeded demo already has 4 members + 1 rule + SLAs." },
  { n: 6, t: "Run the demo", d: "Message the Telegram bot → watch ticket on the board → GitHub issue appears → Switch room lights up → client gets ack → move ticket → client gets status update. Approve the code-aware draft in Issue drafts if approval is human." },
];

export default function AdminPage() {
  const [s, setS] = useState<Status | null>(null);

  const load = () => Promise.allSettled([api.bots.list(), api.integrations.list(), api.members(), api.routingRules.list(), api.outbacklog()]).then(([b, i, m, r, o]) => {
    setS({
      bots: b.status === "fulfilled" ? b.value.items.length : 0,
      activeBots: b.status === "fulfilled" ? b.value.items.filter((x) => x.status === "active").length : 0,
      integrations: i.status === "fulfilled" ? i.value.items.length : 0,
      members: m.status === "fulfilled" ? m.value.items.length : 0,
      rules: r.status === "fulfilled" ? r.value.items.length : 0,
      failed: o.status === "fulfilled" ? o.value.failedCount : 0,
      backlogAge: o.status === "fulfilled" ? o.value.backlogAge : 0,
    });
  });
  useEffect(() => { void load(); }, []);

  async function resyncTicket() {
    const id = window.prompt("Ticket UUID to re-sync (tracker-sync):");
    if (!id) return;
    try { await api.trackerSync(id.trim()); toast.success("Tracker re-sync started"); } catch { toast.error("Failed to re-sync ticket"); }
  }

  const chip = (label: string, ok: boolean, text: string) => (
    <span className="rounded bg-s2 px-2.5 py-1 text-xs text-t1">{label}: <strong className={ok ? "text-t1" : "text-warn"}>{text}</strong></span>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold text-t1">Setup &amp; demo walkthrough</h1>
        <p className="mt-1 text-[13px] text-t2">Secrets never go in the browser: tokens live in the server <code>.env</code>, only <code>env:NAME</code> references are stored here. Writes need the <code>pm</code> role.</p>
      </div>

      <section className="rounded-xl border border-line bg-bg p-4">
        <h2 className="text-sm font-semibold text-t1">Live status</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {s ? (<>
            {chip("Bots", s.activeBots > 0, `${s.activeBots}/${s.bots} active`)}
            {chip("GitHub", s.integrations > 0, s.integrations > 0 ? `${s.integrations} connected` : "not connected")}
            {chip("Members", s.members > 0, `${s.members}`)}
            {chip("Routing", s.rules > 0, `${s.rules} rules`)}
            {chip("Outbox", s.failed === 0, s.failed === 0 ? "healthy" : `${s.failed} failed`)}
          </>) : <span className="text-[13px] text-t3">Loading…</span>}
        </div>
        <div className="mt-3 flex gap-2"><Button onClick={() => void load()}>Refresh status</Button><Button onClick={() => void resyncTicket()}>Re-sync a ticket…</Button></div>
      </section>

      <section className="rounded-xl border border-line bg-bg p-4">
        <h2 className="text-sm font-semibold text-t1">Setup steps</h2>
        <ol className="mt-2 space-y-3">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3 text-[13px]"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-s3 font-semibold text-t1">{s.n}</span><span className="text-t2"><strong className="text-t1">{s.t}.</strong> {s.d}</span></li>
          ))}
        </ol>
      </section>

      <AdminBots />
      <AdminIntegrations />
      <AdminTeamRoles />
      <AdminRoutingRules />
      <AdminChatConnections />
    </div>
  );
}
