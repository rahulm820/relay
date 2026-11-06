"use client";
import * as D from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./ui";

export interface MenuOption { value: string; label: ReactNode; disabled?: boolean }

/** Select-like dropdown on Radix: arrow keys, type-ahead, Esc and focus return come from the primitive. */
export function MenuSelect({ options, value, onSelect, children, ariaLabel, disabled, align = "start", className }: {
  options: readonly MenuOption[]; value?: string; onSelect: (v: string) => void; children: ReactNode; ariaLabel: string; disabled?: boolean; align?: "start" | "end"; className?: string;
}) {
  return (
    <D.Root>
      <D.Trigger disabled={disabled} aria-label={ariaLabel} className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-s2 px-2.5 text-[13px] text-t1 transition-colors hover:bg-s3 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-s3 max-md:h-11", className)}>
        {children}
        <ChevronDown className="size-3.5 text-t3" aria-hidden />
      </D.Trigger>
      <D.Portal>
        <D.Content align={align} sideOffset={6} className="z-[70] max-h-72 min-w-44 overflow-auto rounded-lg border border-line-strong bg-s2 p-1 shadow-xl animate-[fade-in_120ms_var(--ease)]">
          {options.length === 0 && <p className="px-2.5 py-2 text-[13px] text-t3">No options</p>}
          {options.map((o) => (
            <D.Item key={o.value} disabled={o.disabled} onSelect={() => onSelect(o.value)} className="flex cursor-default items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px] text-t1 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-s3 max-md:py-3">
              <span className="flex items-center gap-2">{o.label}</span>
              {o.value === value && <Check className="size-3.5 text-accent" aria-hidden />}
            </D.Item>
          ))}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
