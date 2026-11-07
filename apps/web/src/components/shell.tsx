"use client";
import * as D from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, KanbanSquare, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import type { Me } from "../lib/schemas";
import { Wordmark } from "./brand";
import { cn } from "./ui";

const NAV = [
  { href: "/", label: "Tickets", icon: KanbanSquare },
  { href: "/admin", label: "Setup", icon: Settings },
] as const;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();

  async function signOut() {
    try { await api.logout(); } catch { /* the cookie is cleared server-side on success; on failure we still leave */ }
    qc.clear();
    router.replace("/login");
    toast.success("Signed out");
  }

  return (
    <div className="flex h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[100] focus:rounded focus:bg-s3 focus:px-3 focus:py-2">Skip to content</a>
      <header className="z-30 flex h-12 shrink-0 items-center gap-6 border-b border-line bg-bg/90 px-4 backdrop-blur">
        <Link href="/" aria-label="Relay home" className="rounded"><Wordmark /></Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium transition-colors max-md:h-11", active ? "bg-s2 text-t1" : "text-t2 hover:bg-s1 hover:text-t1")}>
                <Icon className="size-4" aria-hidden /> {label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <D.Root>
            <D.Trigger className="flex h-8 items-center gap-2 rounded-md px-1.5 text-[13px] text-t2 transition-colors hover:bg-s1 hover:text-t1 data-[state=open]:bg-s1 max-md:h-11" aria-label="Account menu">
              <span className="grid size-6 place-items-center rounded-full bg-s3 text-[11px] font-semibold text-t1">{initials(me.user.name)}</span>
              <span className="hidden sm:inline">{me.user.name}</span>
              <ChevronDown className="size-3.5" aria-hidden />
            </D.Trigger>
            <D.Portal>
              <D.Content align="end" sideOffset={6} className="z-50 w-60 rounded-lg border border-line-strong bg-s2 p-1 shadow-xl animate-[fade-in_120ms_var(--ease)]">
                <div className="px-2.5 py-2">
                  <p className="truncate text-[13px] font-medium text-t1">{me.user.name}</p>
                  <p className="truncate text-xs text-t3">{me.user.email}</p>
                  <p className="mt-1 text-xs text-t3">{me.tenant.name ?? "Workspace"} · <span className="capitalize">{me.user.role}</span></p>
                </div>
                <D.Separator className="my-1 h-px bg-line" />
                <D.Item onSelect={() => void signOut()} className="flex cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-t1 outline-none data-[highlighted]:bg-s3 max-md:py-3">
                  <LogOut className="size-4 text-t2" aria-hidden /> Sign out
                </D.Item>
              </D.Content>
            </D.Portal>
          </D.Root>
        </div>
      </header>
      <main id="main" className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
