"use client";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Inbox, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, PRIORITIES, type Priority } from "@relay/shared/browser";
import { ApiRequestError, api } from "../lib/api";
import { useMembers, useNow } from "../lib/hooks";
import type { Ticket } from "../lib/schemas";
import { CATEGORY_LABEL, LANES, NO_FILTERS, groupByLane, hasActiveFilters, matchesQuery, shortId, type LaneId, type TicketFilters } from "../lib/tickets";
import { exactTime, relativeTime } from "../lib/time";
import { Drawer } from "./drawer";
import { PriorityChip, SlaChip, StatusChip } from "./chips";
import { MenuSelect } from "./menu";
import { Tip } from "./tip";
import { Button, Skeleton, cn } from "./ui";

export const TICKETS_KEY = ["tickets"] as const;
const POLL_MS = 10_000;

const EMPTY_COPY: Record<LaneId, string> = {
  inbox: "New client messages land here first, before anyone has decided what to do.",
  triaged: "Tickets that have been classified and are waiting for someone to pick them up.",
  progress: "Tickets that someone is working on or reviewing.",
  resolved: "Fixed tickets appear here until they are closed.",
};

export function Board() {
  const params = useSearchParams();
  const pathname = usePathname();
  const openId = params.get("ticket");
  const [filters, setFilters] = useState<TicketFilters>(NO_FILTERS);

  // react-query pauses interval polling while the tab is hidden (refetchIntervalInBackground defaults to false)
  // and refetches on focus, so a returning user sees fresh data immediately.
  const list = useQuery({
    queryKey: TICKETS_KEY,
    queryFn: () => api.listTickets({ limit: 100 }),
    refetchInterval: POLL_MS,
    placeholderData: (prev) => prev,
  });
  const members = useMembers();
  const nameOf = useMemo(() => new Map(members.data?.items.map((m) => [m.id, m.name]) ?? []), [members.data]);

  const all = list.data?.items ?? [];
  const visible = useMemo(
    () => all.filter((t) => (filters.priority === "all" || t.priority === filters.priority) && (filters.category === "all" || t.category === filters.category) && matchesQuery(t, filters.query)),
    [all, filters],
  );
  const lanes = useMemo(() => groupByLane(visible), [visible]);

  // Cards that arrive after the first load get an entrance animation; the initial render and filter changes do not.
  const known = useRef<Set<string> | null>(null);
  const fresh = useMemo(() => {
    if (known.current === null) return new Set<string>();
    return new Set(all.filter((t) => !known.current!.has(t.id)).map((t) => t.id));
  }, [all]);
  useEffect(() => { if (list.data) known.current = new Set(list.data.items.map((t) => t.id)); }, [list.data]);

  const loading = list.isPending;
  const failed = list.isError && !list.data;

  return (
    <div className="flex h-full flex-col">
      <Toolbar filters={filters} onChange={setFilters} total={all.length} shown={visible.length} updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.isError && !!list.data} onRefresh={() => void list.refetch()} />
      {failed ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !loading && all.length === 0 ? (
        <EmptyBoard />
      ) : !loading && visible.length === 0 ? (
        <NoMatches onClear={() => setFilters(NO_FILTERS)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-x-auto px-4 pb-4 max-md:snap-x max-md:snap-mandatory">
          <div className="grid h-full min-w-[1040px] grid-cols-4 gap-3 max-md:min-w-[1180px]">
            {LANES.map((lane) => (
              <Lane key={lane.id} id={lane.id} label={lane.label} hint={lane.hint} tickets={lanes[lane.id]} loading={loading} fresh={fresh} nameOf={nameOf} />
            ))}
          </div>
        </div>
      )}
      <Drawer ticketId={openId} pathname={pathname} />
    </div>
  );
}

function Toolbar({ filters, onChange, total, shown, updatedAt, fetching, error, onRefresh }: {
  filters: TicketFilters; onChange: (f: TicketFilters) => void; total: number; shown: number; updatedAt: number; fetching: boolean; error: boolean; onRefresh: () => void;
}) {
  const now = useNow() || Date.now();
  const age = updatedAt ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : null;
  return (
    <div role="search" className="flex flex-wrap items-center gap-2 px-4 py-3">
      <h1 className="mr-2 text-[15px] font-semibold tracking-tight">Tickets</h1>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" aria-hidden />
        <input aria-label="Search tickets by title or ID" placeholder="Search title or ID" value={filters.query} onChange={(e) => onChange({ ...filters, query: e.target.value })} className="h-8 w-56 rounded-md border border-line-strong bg-s1 pl-8 pr-2 text-[13px] placeholder:text-t3 outline-none focus:border-accent max-md:h-11 max-md:w-full" />
      </div>
      <div role="group" aria-label="Filter by priority" className="flex items-center gap-0.5 rounded-md border border-line-strong bg-s1 p-0.5">
        {(["all", ...PRIORITIES] as const).map((p) => (
          <button key={p} type="button" aria-pressed={filters.priority === p} onClick={() => onChange({ ...filters, priority: p as Priority | "all" })} className={cn("h-7 rounded px-2 text-xs font-medium transition-colors max-md:h-10 max-md:px-3", filters.priority === p ? "bg-s3 text-t1" : "text-t2 hover:text-t1")}>
            {p === "all" ? "All" : p}
          </button>
        ))}
      </div>
      <MenuSelect ariaLabel="Filter by category" value={filters.category} onSelect={(v) => onChange({ ...filters, category: v as TicketFilters["category"] })} options={[{ value: "all", label: "All categories" }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]}>
        {filters.category === "all" ? "Category" : CATEGORY_LABEL[filters.category]}
      </MenuSelect>
      {hasActiveFilters(filters) && (
        <Button variant="ghost" className="h-8 !min-h-8" onClick={() => onChange(NO_FILTERS)}><X className="size-3.5" aria-hidden /> Clear</Button>
      )}
      <div className="ml-auto flex items-center gap-3 text-xs text-t3" aria-live="polite">
        {hasActiveFilters(filters) && <span className="tnum">{shown} of {total}</span>}
        {error ? <span className="text-warn">Reconnecting…</span> : age !== null && <span className="tnum">Updated {age < 5 ? "just now" : `${age}s ago`}</span>}
        <Tip label="Refresh now">
          <button type="button" onClick={onRefresh} aria-label="Refresh tickets" className="grid size-8 place-items-center rounded-md text-t2 transition-colors hover:bg-s2 hover:text-t1 max-md:size-11">
            <RefreshCw className={cn("size-3.5", fetching && "animate-spin")} aria-hidden />
          </button>
        </Tip>
      </div>
    </div>
  );
}

function Lane({ id, label, hint, tickets, loading, fresh, nameOf }: {
  id: LaneId; label: string; hint: string; tickets: Ticket[]; loading: boolean; fresh: Set<string>; nameOf: Map<string, string>;
}) {
  return (
    <section aria-labelledby={`lane-${id}`} className="flex min-h-0 flex-col rounded-xl border border-line bg-s1/60 max-md:snap-start">
      <header className="flex items-center justify-between px-3 py-2.5">
        <Tip label={hint}>
          <h2 id={`lane-${id}`} className="cursor-default text-[13px] font-semibold text-t1">{label}</h2>
        </Tip>
        {!loading && <span className="rounded-full bg-s3 px-2 text-xs font-medium text-t2 tnum" aria-label={`${tickets.length} tickets`}>{tickets.length}</span>}
      </header>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2" aria-label={`${label} tickets`}>
        {loading ? (
          Array.from({ length: id === "inbox" ? 3 : 2 }, (_, i) => <li key={i}><CardSkeleton /></li>)
        ) : tickets.length === 0 ? (
          <li className="px-2 py-6 text-center text-[13px] text-t3">
            {EMPTY_COPY[id]}
          </li>
        ) : (
          tickets.map((t) => <li key={t.id}><Card ticket={t} isNew={fresh.has(t.id)} assignee={t.assigneeId ? nameOf.get(t.assigneeId) : undefined} /></li>)
        )}
      </ul>
    </section>
  );
}

const Card = memo(function Card({ ticket: t, isNew, assignee }: { ticket: Ticket; isNew: boolean; assignee: string | undefined }) {
  const now = useNow() || Date.now();
  const quarantined = t.status === "quarantined";
  return (
    <Link
      href={`?ticket=${t.id}`}
      data-ticket={t.id}
      scroll={false}
      className={cn(
        "group block rounded-lg border bg-s2 p-3 transition-[border-color,background-color,transform] duration-150 hover:border-line-strong hover:bg-s3 active:scale-[0.995]",
        quarantined ? "border-quarantine/40 bg-[linear-gradient(0deg,rgba(201,164,255,0.06),rgba(201,164,255,0.06)),var(--surface-2)]" : "border-line",
        isNew && "animate-card-in",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-t3">{shortId(t.id)}</span>
        <PriorityChip priority={t.priority} />
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13px] font-medium leading-snug text-t1">{t.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusChip status={t.status} />
        <span className="text-[11px] text-t3">{CATEGORY_LABEL[t.category]}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <SlaChip ticket={t} />
        <div className="flex min-w-0 items-center gap-2">
          {(assignee || t.roleNeeded) && (
            <span className="truncate text-[11px] text-t2" title={assignee ? undefined : "Role needed"}>{assignee ?? `Needs ${t.roleNeeded}`}</span>
          )}
          <Tip label={exactTime(t.createdAt)}><time dateTime={t.createdAt} className="shrink-0 text-[11px] text-t3 tnum">{relativeTime(t.createdAt, now)}</time></Tip>
        </div>
      </div>
    </Link>
  );
});

function CardSkeleton() {
  return (
    <div className="rounded-lg border border-line bg-s2 p-3" aria-hidden>
      <div className="flex justify-between"><Skeleton className="h-3 w-20" /><Skeleton className="h-4 w-8" /></div>
      <Skeleton className="mt-3 h-3.5 w-full" /><Skeleton className="mt-1.5 h-3.5 w-2/3" />
      <div className="mt-3 flex gap-3"><Skeleton className="h-3 w-16" /><Skeleton className="h-3 w-12" /></div>
      <div className="mt-3 flex justify-between"><Skeleton className="h-4 w-16" /><Skeleton className="h-3 w-10" /></div>
    </div>
  );
}

function EmptyBoard() {
  return (
    <div className="grid flex-1 place-items-center px-4">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full border border-line-strong bg-s1"><Inbox className="size-5 text-t2" aria-hidden /></div>
        <h2 className="mt-4 text-[15px] font-semibold">No tickets yet</h2>
        <p className="mt-1.5 text-[13px] text-t2">When a client writes to your Telegram bot, Relay turns the message into a ticket and it appears here within seconds. This page refreshes on its own.</p>
      </div>
    </div>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="grid flex-1 place-items-center px-4">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full border border-line-strong bg-s1"><Search className="size-5 text-t2" aria-hidden /></div>
        <h2 className="mt-4 text-[15px] font-semibold">No tickets match</h2>
        <p className="mt-1.5 text-[13px] text-t2">Nothing fits the current search and filters. Try a different title, or clear the filters.</p>
        <Button className="mt-4" onClick={onClear}><X className="size-4" aria-hidden /> Clear filters</Button>
      </div>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const msg = error instanceof ApiRequestError ? error.message : "Something went wrong.";
  return (
    <div className="grid flex-1 place-items-center px-4" role="alert">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid size-10 place-items-center rounded-full border border-bad/30 bg-bad/10"><AlertCircle className="size-5 text-bad" aria-hidden /></div>
        <h2 className="mt-4 text-[15px] font-semibold">Could not load tickets</h2>
        <p className="mt-1.5 text-[13px] text-t2">{msg}</p>
        <Button className="mt-4" onClick={onRetry}><RefreshCw className="size-4" aria-hidden /> Retry</Button>
      </div>
    </div>
  );
}

