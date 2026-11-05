"use client";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api } from "./api";

// One shared 1 s clock for every countdown on the page, so a hundred SLA chips cost one timer, not a hundred.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let tick = Math.floor(Date.now() / 1000) * 1000;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) timer = setInterval(() => { tick = Math.floor(Date.now() / 1000) * 1000; listeners.forEach((l) => l()); }, 1000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = undefined; }
  };
}
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => tick, () => 0);
}

export const ME_KEY = ["me"] as const;
export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: api.me, staleTime: 60_000, retry: false });
}

export function useMembers() {
  return useQuery({ queryKey: ["members"], queryFn: api.members, staleTime: 5 * 60_000 });
}
