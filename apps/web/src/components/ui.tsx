import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent-solid text-white hover:bg-[var(--accent-solid-hover)] border-transparent",
  secondary: "bg-s2 text-t1 border-line-strong hover:bg-s3",
  ghost: "bg-transparent text-t2 border-transparent hover:bg-s2 hover:text-t1",
  danger: "bg-transparent text-bad border-line-strong hover:bg-s2",
};

export function Button({ variant = "secondary", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; children: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-[var(--radius-sm)] border px-3 text-[13px] font-medium transition-colors duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cn("skeleton", className)} aria-hidden />;

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-s2 px-1.5 py-0.5 font-mono text-[11px] text-t2">{children}</kbd>;
}
