"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { RoutingRule, SlaPolicy } from "../lib/schemas";
import { toast } from "sonner";
import { Button } from "./ui";

const input = "h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-s1 px-3 text-[13px] text-t1 placeholder:text-t3 outline-none focus:border-accent";

export function AdminRoutingRules() {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [slas, setSlAs] = useState<SlaPolicy[]>([]);
  const [position, setPosition] = useState(2);
  const [conditionText, setConditionText] = useState("{}");
  const [actionText, setActionText] = useState('{"role":"developer"}');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.routingRules.list().then((d) => setRules(d.items)).catch(() => toast.error("Could not load routing rules"));
    api.slaPolicies.list().then((d) => setSlAs(d.items)).catch(() => {});
  };
  useEffect(() => { void load(); }, []);

  async function create() {
    let condition: Record<string, unknown>; let action: Record<string, unknown>;
    try { condition = JSON.parse(conditionText); action = JSON.parse(actionText); } catch { return toast.error("Condition and action must be valid JSON"); }
    setBusy(true);
    try { await api.routingRules.create({ position, condition, action, enabled: true }); toast.success("Routing rule added"); void load(); }
    catch { toast.error("Failed to add routing rule"); } finally { setBusy(false); }
  }

  async function toggle(r: RoutingRule) {
    try { await api.routingRules.patch(r.id, { enabled: !r.enabled }); void load(); } catch { toast.error("Failed to update rule"); }
  }

  return (
    <section className="rounded-xl border border-line bg-bg p-4">
      <h2 className="text-sm font-semibold text-t1">Routing rules &amp; SLA</h2>
      <p className="mt-1 text-[13px] text-t2">Rules run in position order, e.g. bug → developer, ui → designer, everything else → pm.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={input} style={{ maxWidth: 90 }} type="number" value={position} onChange={(e) => setPosition(Number(e.target.value))} aria-label="position" />
        <input className={input} style={{ maxWidth: 180 }} value={conditionText} onChange={(e) => setConditionText(e.target.value)} aria-label="condition JSON" />
        <input className={input} style={{ maxWidth: 220 }} value={actionText} onChange={(e) => setActionText(e.target.value)} aria-label="action JSON" />
        <Button variant="primary" loading={busy} onClick={() => void create()}>Add rule</Button>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
            <span className="font-medium text-t1">#{r.position}</span>
            <code className="text-xs text-t2">{JSON.stringify(r.condition)} → {JSON.stringify(r.action)}</code>
            <span className="ml-auto flex items-center gap-2"><span className="text-xs text-t3">{r.enabled ? "enabled" : "disabled"}</span><Button onClick={() => void toggle(r)}>{r.enabled ? "Disable" : "Enable"}</Button></span>
          </li>
        ))}
        {rules.length === 0 && <li className="py-2 text-[13px] text-t3">No routing rules yet (seed creates one).</li>}
      </ul>
      {slas.length > 0 && <p className="mt-3 text-xs text-t3">SLA targets: {slas.map((s) => `${s.priority} ack ${s.ackMinutes}m / resolve ${s.resolveMinutes}m`).join(" · ")}</p>}
    </section>
  );
}
