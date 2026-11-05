"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Bell, CircleDot, Flag, GitBranch, MessageSquare, Plus, ShieldAlert, UserRound, X, ArrowRight, AlertCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { PRIORITIES, type Priority, type TicketStatus } from "@relay/shared/browser";
import { ApiRequestError, api } from "../lib/api";
import { describeEvent, quarantineReason, type EventKind } from "../lib/events";
import { safeGithubUrl } from "../lib/github";
import { useMembers, useNow } from "../lib/hooks";
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, legalNextStatuses, shortId } from "../lib/tickets";
import { exactTime, relativeTime } from "../lib/time";
import type { Ticket, TicketEvent } from "../lib/schemas";
import { PriorityChip, SlaChip, StatusChip } from "./chips";
import { MenuSelect } from "./menu";
import { Tip } from "./tip";
import { Button, Skeleton } from "./ui";

const TICKETS_KEY = ["tickets"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Slide-over for one ticket, deep-linked by ?ticket=<id>. Radix Dialog gives the focus trap, Esc, and focus return. */
export function Drawer({ ticketId, pathname }: { ticketId: string | null; pathname: string }) {
  const router = useRouter();
  const open = !!ticketId;
  // The drawer is driven by the URL, so there is no Dialog.Trigger for Radix to return focus to. Remember the last
  // opened ticket and focus its card on close (keyboard users land back where they were).
  const last = useRef<string | null>(null);
  if (ticketId) last.current = ticketId;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) router.replace(pathname, { scroll: false }); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_160ms_var(--ease)]" />
        <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={(e) => { e.preventDefault(); document.querySelector<HTMLElement>(`a[data-ticket="${last.current}"]`)?.focus(); }} className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col border-l border-line-strong bg-s1 shadow-2xl outline-none animate-[drawer-in_200ms_var(--ease)] max-sm:max-w-none">
          {ticketId && <DrawerBody id={ticketId} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DrawerBody({ id }: { id: string }) {
  const valid = UUID.test(id);
  const q = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api.getTicket(id),
    enabled: valid,
    refetchInterval: 10_000,
    retry: (n, err) => !(err instanceof ApiRequestError && err.kind === "not_found") && n < 2,
  });
  const members = useMembers();
  const nameOf = useMemo(() => new Map(members.data?.items.map((m) => [m.id, m.name]) ?? []), [members.data]);
  const notFound = !valid || (q.error instanceof ApiRequestError && q.error.kind === "not_found");

  return (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <Dialog.Title className="sr-only">{q.data ? q.data.ticket.title : "Ticket"}</Dialog.Title>
          {q.data ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-t2">{shortId(q.data.ticket.id)}</span>
              <PriorityChip priority={q.data.ticket.priority} withLabel />
              <StatusChip status={q.data.ticket.status} />
            </div>
          ) : <Skeleton className="h-5 w-48" />}
        </div>
        <Dialog.Close aria-label="Close ticket" className="grid size-8 shrink-0 place-items-center rounded-md text-t2 transition-colors hover:bg-s2 hover:text-t1 max-md:size-11">
          <X className="size-4" aria-hidden />
        </Dialog.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notFound ? (
          <Centered icon={<AlertCircle className="size-5 text-t2" aria-hidden />} title="Ticket not found" body="It may have been removed, or the link is wrong." />
        ) : q.isError && !q.data ? (
          <Centered icon={<AlertCircle className="size-5 text-bad" aria-hidden />} title="Could not load this ticket" body={q.error instanceof ApiRequestError ? q.error.message : "Something went wrong."} action={<Button onClick={() => void q.refetch()}><RefreshCw className="size-4" aria-hidden /> Retry</Button>} />
        ) : !q.data ? (
          <DetailSkeleton />
        ) : (
          <Detail ticket={q.data.ticket} events={q.data.events} nameOf={nameOf} members={members.data?.items ?? []} />
        )}
      </div>
    </>
  );
}

function Centered({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6" role="alert">
      <div className="text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full border border-line-strong bg-s2">{icon}</div>
        <h3 className="mt-3 text-[15px] font-semibold">{title}</h3>
        <p className="mt-1 text-[13px] text-t2">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5 px-5 py-5" aria-busy="true" aria-label="Loading ticket">
      <Skeleton className="h-6 w-4/5" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/5" />
      <div className="grid grid-cols-2 gap-3 pt-2"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      <Skeleton className="h-24" />
    </div>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof ApiRequestError ? err.message : "Something went wrong. Try again.";
}

function Detail({ ticket: t, events, nameOf, members }: { ticket: Ticket; events: TicketEvent[]; nameOf: Map<string, string>; members: Array<{ id: string; name: string; role: string; active: boolean }> }) {
  const qc = useQueryClient();
  const now = useNow() || Date.now();
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const github = safeGithubUrl(t.trackerRef);
  const heldReason = t.status === "quarantined" ? quarantineReason(events) : undefined;

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ["ticket", t.id] }), qc.invalidateQueries({ queryKey: TICKETS_KEY })]);
  };

  const move = useMutation({
    mutationFn: (to: TicketStatus) => api.transition(t.id, to, t.status, reason.trim() || undefined),
    onSuccess: async (_, to) => { setReason(""); await refresh(); toast.success(`Moved to ${STATUS_LABEL[to]}`); },
    onError: async (err) => {
      if (err instanceof ApiRequestError && (err.kind === "status_conflict" || err.kind === "illegal_transition")) {
        await refresh(); // show what the ticket really looks like now
        toast.error(err.kind === "status_conflict" ? "Someone else changed this ticket. It has been refreshed; check and try again." : "That move is not allowed from the ticket's current status.");
      } else if (!(err instanceof ApiRequestError && err.kind === "unauthorized")) toast.error(errorMessage(err));
    },
  });
  const patch = useMutation({
    mutationFn: (p: { priority?: Priority; assigneeId?: string | null }) => api.patchTicket(t.id, p),
    onSuccess: async () => { await refresh(); toast.success("Ticket updated"); },
    onError: (err) => { if (!(err instanceof ApiRequestError && err.kind === "unauthorized")) toast.error(errorMessage(err)); },
  });
  const busy = move.isPending || patch.isPending;
  const next = legalNextStatuses(t.status);
  const assignee = t.assigneeId ? nameOf.get(t.assigneeId) ?? "Unknown member" : null;

  return (
    <div className="px-5 py-5">
      <h2 className="text-lg font-semibold leading-snug tracking-tight">{t.title}</h2>
      {/* Plain text on purpose: the summary comes from a client and an LLM. React escapes it; no HTML/markdown rendering. */}
      <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-t2">{t.summary}</p>

      {t.status === "quarantined" && (
        <div className="mt-4 flex gap-3 rounded-lg border border-quarantine/40 bg-quarantine/10 p-3" role="note">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-quarantine" aria-hidden />
          <div className="text-[13px]">
            <p className="font-medium text-quarantine">Needs human triage</p>
            <p className="mt-0.5 text-t2">Relay held this ticket instead of acting on it, so nothing has been sent to GitHub or the client. Read it, then move it to Triaged to release it.</p>
            {heldReason && <p className="mt-1.5 text-t3">Reason: {heldReason}</p>}
          </div>
        </div>
      )}

      <section aria-labelledby="actions-h" className="mt-5 rounded-lg border border-line bg-s2/60 p-3">
        <h3 id="actions-h" className="sr-only">Actions</h3>
        <div className="flex flex-wrap items-center gap-2">
          <MenuSelect ariaLabel="Move ticket to another status" disabled={busy || next.length === 0} onSelect={(v) => move.mutate(v as TicketStatus)} options={next.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}>
            <ArrowRight className="size-3.5 text-t2" aria-hidden /> {move.isPending ? "Moving…" : "Move to"}
          </MenuSelect>
          <MenuSelect ariaLabel="Change priority" value={t.priority} disabled={busy} onSelect={(v) => { if (v !== t.priority) patch.mutate({ priority: v as Priority }); }} options={PRIORITIES.map((p) => ({ value: p, label: <><PriorityChip priority={p} /> {PRIORITY_LABEL[p]}</> }))}>
            <Flag className="size-3.5 text-t2" aria-hidden /> Priority
          </MenuSelect>
          <MenuSelect ariaLabel="Change assignee" value={t.assigneeId ?? ""} disabled={busy} onSelect={(v) => { const id = v === "" ? null : v; if (id !== t.assigneeId) patch.mutate({ assigneeId: id }); }} options={[{ value: "", label: "Unassigned" }, ...members.filter((m) => m.active).map((m) => ({ value: m.id, label: <>{m.name} <span className="text-t3">· {m.role}</span></> }))]}>
            <UserRound className="size-3.5 text-t2" aria-hidden /> Assignee
          </MenuSelect>
        </div>
        {next.length > 0 && (
          <div className="mt-3">
            <label htmlFor={reasonId} className="text-xs text-t3">Reason for the next move (optional, recorded in the timeline)</label>
            <input id={reasonId} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} className="mt-1 h-8 w-full rounded-md border border-line-strong bg-s1 px-2.5 text-[13px] placeholder:text-t3 outline-none focus:border-accent max-md:h-11" placeholder="e.g. Reproduced on staging" />
          </div>
        )}
      </section>

      <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 text-[13px]">
        <Fact label="Category">{CATEGORY_LABEL[t.category]}</Fact>
        <Fact label="Priority">
          <span className="inline-flex items-center gap-1.5"><PriorityChip priority={t.priority} /> <span className="text-t3">{t.prioritySource === "human" ? "set by a teammate" : t.prioritySource === "llm" ? "set by AI" : "set by rules"}</span></span>
          {t.priorityReason && t.prioritySource !== "human" && <span className="mt-1 block text-xs text-t3">{t.priorityReason}</span>}
        </Fact>
        <Fact label="Assignee">{assignee ?? <span className="text-t3">{t.roleNeeded ? `Unassigned · needs ${t.roleNeeded}` : "Unassigned"}</span>}</Fact>
        <Fact label="Resolve SLA"><span className="inline-flex flex-col items-start gap-1"><SlaChip ticket={t} />{t.slaResolveDue && <span className="text-xs text-t3 tnum">Due {exactTime(t.slaResolveDue)}</span>}</span></Fact>
        <Fact label="First-response SLA">{t.slaAckDue ? <span className="tnum">{exactTime(t.slaAckDue)}</span> : <span className="text-t3">None</span>}</Fact>
        <Fact label="Created"><Tip label={exactTime(t.createdAt)}><time dateTime={t.createdAt} className="tnum">{relativeTime(t.createdAt, now)}</time></Tip></Fact>
        <Fact label="Clients affected"><span className="tnum">{t.affectedClientCount}</span></Fact>
      </dl>

      <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-t3">Links</h3>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line text-[13px]">
        <li className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="inline-flex items-center gap-2 text-t2"><GitBranch className="size-4" aria-hidden /> GitHub issue</span>
          {github ? (
            <a href={github} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 text-accent hover:underline">
              <span className="truncate">{new URL(github).pathname.slice(1)}</span><ArrowUpRight className="size-3.5 shrink-0" aria-hidden /><span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : t.trackerRef ? <span className="truncate font-mono text-xs text-t2">{t.trackerRef}</span> : <span className="text-t3">Not linked yet</span>}
        </li>
        <li className="flex items-center justify-between gap-3 px-3 py-2.5">
          <span className="inline-flex items-center gap-2 text-t2"><MessageSquare className="size-4" aria-hidden /> Switch room</span>
          {t.switchRoomRef ? <span className="truncate font-mono text-xs text-t2">{t.switchRoomRef}</span> : <span className="text-t3">Not linked yet</span>}
        </li>
      </ul>

      <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-t3">Timeline</h3>
      <ol className="mt-3" aria-label="Ticket timeline">
        {[...events].reverse().map((e, i, arr) => {
          const l = describeEvent(e, nameOf);
          return (
            <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
              {i < arr.length - 1 && <span aria-hidden className="absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px bg-line" />}
              <span className="relative z-[1] grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-s2 text-t2">{EVENT_ICON[l.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-t1">{l.title}</p>
                {l.detail && <p className="mt-0.5 break-words text-xs text-t3">{l.detail}</p>}
                <p className="mt-0.5 text-xs text-t3"><span>{l.actor}</span> · <Tip label={exactTime(e.createdAt)}><time dateTime={e.createdAt} className="tnum">{relativeTime(e.createdAt, now)}</time></Tip></p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const EVENT_ICON: Record<EventKind, ReactNode> = {
  created: <Plus className="size-3" aria-hidden />,
  status: <CircleDot className="size-3" aria-hidden />,
  priority: <Flag className="size-3" aria-hidden />,
  assignee: <UserRound className="size-3" aria-hidden />,
  notify: <Bell className="size-3" aria-hidden />,
  other: <CircleDot className="size-3" aria-hidden />,
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-t3">{label}</dt>
      <dd className="mt-1 text-t1">{children}</dd>
    </div>
  );
}
