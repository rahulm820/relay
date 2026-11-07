"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Member } from "../lib/schemas";
import { toast } from "sonner";
import { Button } from "./ui";

const input = "h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-s1 px-3 text-[13px] text-t1 placeholder:text-t3 outline-none focus:border-accent";
const ROLES = ["pm", "developer", "designer", "tester"] as const;

export function AdminTeamRoles() {
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("developer");
  const [chatHandle, setChatHandle] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.members().then((d) => setMembers(d.items)).catch(() => toast.error("Could not load members"));
  useEffect(() => { void load(); }, []);

  async function create() {
    if (!name.trim()) return toast.error("Name is required");
    setBusy(true);
    try { await api.memberAdmin.create({ name: name.trim(), role, chatHandle: chatHandle.trim() || null, timezone: "UTC", active: true }); setName(""); setChatHandle(""); toast.success("Member added"); void load(); }
    catch { toast.error("Failed to add member (pm role required)"); } finally { setBusy(false); }
  }

  return (
    <section className="rounded-xl border border-line bg-bg p-4">
      <h2 className="text-sm font-semibold text-t1">Team &amp; roles</h2>
      <p className="mt-1 text-[13px] text-t2">Chat handles are Mattermost/Switch usernames used to ping owners in ticket rooms.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input className={input} style={{ maxWidth: 200 }} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <select className={input} style={{ maxWidth: 140 }} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <input className={input} style={{ maxWidth: 180 }} placeholder="chat handle" value={chatHandle} onChange={(e) => setChatHandle(e.target.value)} />
        <Button variant="primary" loading={busy} onClick={() => void create()}>Add member</Button>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {members.map((m) => (
          <li key={m.id} className="flex gap-3 py-2 text-[13px]"><span className="font-medium text-t1">{m.name}</span><span className="text-t2">{m.role}</span><span className="text-t3">{m.chatHandle ?? ""}</span><span className="ml-auto text-xs text-t3">{m.active ? "active" : "inactive"}</span></li>
        ))}
        {members.length === 0 && <li className="py-2 text-[13px] text-t3">No members yet.</li>}
      </ul>
    </section>
  );
}
