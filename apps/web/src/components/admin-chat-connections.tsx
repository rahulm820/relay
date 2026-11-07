"use client";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ChatConnection } from "../lib/schemas";
import { toast } from "sonner";

export function AdminChatConnections() {
  const [items, setItems] = useState<ChatConnection[]>([]);

  useEffect(() => {
    api.chatConnections.list().then((d) => setItems(d.items)).catch(() => toast.error("Could not load chat connections"));
  }, []);

  return (
    <section className="rounded-xl border border-line bg-bg p-4">
      <h2 className="text-sm font-semibold text-t1">Chat connections</h2>
      <p className="mt-1 text-[13px] text-t2">Read-only here. The live team chat is Switch (Mattermost bridge on a standalone install): ticket rooms appear there automatically once the worker has <code>SWITCH_*</code> configured — see step 4 above.</p>
      <ul className="mt-3 divide-y divide-line">
        {items.map((c) => (
          <li key={c.id} className="py-2 text-[13px]"><span className="font-medium text-t1">{c.provider}</span> <span className="text-t2">{c.workspaceRef} · {c.status}</span></li>
        ))}
        {items.length === 0 && <li className="py-2 text-[13px] text-t3">No chat connections. Switch rooms work without one.</li>}
      </ul>
    </section>
  );
}
