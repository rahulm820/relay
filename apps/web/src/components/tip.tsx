"use client";
import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/** Tooltip for supplementary info only; the same information must never be available *only* here. */
export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-[60] rounded-md border border-line-strong bg-s3 px-2 py-1 text-xs text-t1 shadow-lg animate-[fade-in_120ms_var(--ease)]">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
