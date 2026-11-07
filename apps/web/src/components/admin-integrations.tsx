"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Integration } from "../lib/schemas";
import { toast } from "sonner";
import { Button } from "./ui";

const input = "h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-s1 px-3 text-[13px] text-t1 placeholder:text-t3 outline-none focus:border-accent";

export function AdminIntegrations() {
  const [items, setItems] = useState<Integration[]>([]);
  const [repoRef, setRepoRef] = useState("");
  const [credentialsRef, setCredentialsRef] = useState("env:GITHUB_TOKEN");
  const [approvalPolicy, setApprovalPolicy] = useState<"auto" | "human">("human");
  const [codeAware, setCodeAware] = useState(false);
  const [labelMapText, setLabelMapText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.integrations.list().then((d) => setItems(d.items)).catch(() => toast.error("Could not load integrations"));
  useEffect(() => { void load(); }, []);

  async function create() {
    if (!repoRef.trim()) return toast.error("Repo (owner/name) is required");
    let labelMap: Record<string, string> = {};
    try { labelMap = labelMapText.trim() ? (JSON.parse(labelMapText) as Record<string, string>) : {}; }
    catch { return toast.error("Label map must be valid JSON"); }
    setBusy(true);
    try {
      await api.integrations.create({ provider: "github", repoRef: repoRef.trim(), credentialsRef: credentialsRef.trim() || null, approvalPolicy, codeAwareEnabled: codeAware, labelMap });
      toast.success("GitHub integration connected — set GITHUB_TOKEN in server .env"); void load();
    } catch { toast.error("Failed to connect integration"); } finally { setBusy(false); }
  }

  async function resync(id: string) {
    try { await api.integrations.resync(id); toast.success("Re-sync started"); } catch { toast.error("Failed to re-sync"); }
  }

  return (
    <section className="rounded-xl border border-line bg-bg p-4">
      <h2 className="text-sm font-semibold text-t1">GitHub integration</h2>
      <p className="mt-1 text-[13px] text-t2">Least-privilege token (<code>issues:write</code>) lives in server <code>.env</code> as <code>GITHUB_TOKEN</code>; only the <code>env:NAME</code> ref is stored. Use approval <code>human</code> to demo code-aware drafts.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={input} style={{ maxWidth: 200 }} placeholder="owner/repo" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} />
        <input className={input} style={{ maxWidth: 220 }} placeholder="env:GITHUB_TOKEN" value={credentialsRef} onChange={(e) => setCredentialsRef(e.target.value)} />
        <select className={input} style={{ maxWidth: 140 }} value={approvalPolicy} onChange={(e) => setApprovalPolicy(e.target.value as "auto" | "human")}>
          <option value="human">human approval</option><option value="auto">auto</option>
        </select>
        <label className="flex items-center gap-2 text-[13px] text-t2"><input type="checkbox" checked={codeAware} onChange={(e) => setCodeAware(e.target.checked)} /> code-aware</label>
        <Button variant="primary" loading={busy} onClick={() => void create()}>Connect GitHub</Button>
      </div>
      <input className={input} style={{ maxWidth: 640 }} placeholder='Label map JSON, e.g. {"bug":"bug","P1":"priority:p1"}' value={labelMapText} onChange={(e) => setLabelMapText(e.target.value)} />
      <ul className="mt-3 divide-y divide-line">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
            <span className="font-medium text-t1">{i.provider} · {i.repoRef ?? "—"}</span>
            <span className="rounded bg-s2 px-2 py-0.5 text-xs text-t1">{i.status}</span>
            <span className="text-t2">approval: {i.approvalPolicy}{i.codeAwareEnabled ? " · code-aware" : ""}</span>
            {i.lastError && <span className="text-xs text-bad">{i.lastError}</span>}
            <span className="ml-auto"><Button onClick={() => void resync(i.id)}>Re-sync failed</Button></span>
          </li>
        ))}
        {items.length === 0 && <li className="py-2 text-[13px] text-t3">No integrations yet.</li>}
      </ul>
    </section>
  );
}
