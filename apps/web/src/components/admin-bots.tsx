"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Bot } from "../lib/schemas";
import { toast } from "sonner";
import { Button } from "./ui";

const input = "h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-s1 px-3 text-[13px] text-t1 placeholder:text-t3 outline-none focus:border-accent";

export function AdminBots() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("env:TELEGRAM_BOT_TOKEN");
  const [busy, setBusy] = useState(false);

  const load = () => api.bots.list().then((d) => setBots(d.items)).catch(() => toast.error("Could not load bots"));
  useEffect(() => { void load(); }, []);

  async function create() {
    if (!displayName.trim() || !credentialsRef.trim()) return toast.error("Display name and credentials ref are required");
    setBusy(true);
    try { await api.bots.create({ channel: "telegram", displayName: displayName.trim(), credentialsRef: credentialsRef.trim() }); setDisplayName(""); toast.success("Bot registered — now run telegram:register (see setup steps)"); void load(); }
    catch { toast.error("Failed to register bot"); } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this bot?")) return;
    try { await api.bots.remove(id); toast.success("Bot revoked"); void load(); } catch { toast.error("Failed to revoke bot"); }
  }

  return (
    <section className="rounded-xl border border-line bg-bg p-4">
      <h2 className="text-sm font-semibold text-t1">Telegram bots</h2>
      <p className="mt-1 text-[13px] text-t2">Only the <code>env:NAME</code> reference is stored — the token itself lives in the server <code>.env</code>. After creating a bot, run <code>npm run telegram:register</code> to point Telegram at this API (see step 1 above).</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={input} style={{ maxWidth: 220 }} placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className={input} style={{ maxWidth: 260 }} placeholder="env:TELEGRAM_BOT_TOKEN" value={credentialsRef} onChange={(e) => setCredentialsRef(e.target.value)} />
        <Button variant="primary" loading={busy} onClick={() => void create()}>Register bot</Button>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {bots.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
            <span className="font-medium text-t1">{b.displayName}</span>
            <span className="text-t2">{b.channel} · {b.credentialsRef ?? "no ref"}</span>
            <span className="rounded bg-s2 px-2 py-0.5 text-xs text-t1">{b.status}</span>
            {b.lastError && <span className="text-xs text-bad">{b.lastError}</span>}
            <span className="ml-auto flex gap-2">
              {b.status !== "revoked" && <Button variant="danger" onClick={() => void revoke(b.id)}>Revoke</Button>}
            </span>
          </li>
        ))}
        {bots.length === 0 && <li className="py-2 text-[13px] text-t3">No bots yet.</li>}
      </ul>
    </section>
  );
}
