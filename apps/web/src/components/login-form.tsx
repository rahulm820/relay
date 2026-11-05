"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useState, type FormEvent } from "react";
import { ApiRequestError, api } from "../lib/api";
import { ME_KEY, useMe } from "../lib/hooks";
import { safeNext } from "../lib/redirect";
import { Wordmark } from "./brand";
import { Button } from "./ui";

const FIELD = "h-10 w-full rounded-[var(--radius-sm)] border border-line-strong bg-s1 px-3 text-[14px] text-t1 placeholder:text-t3 outline-none transition-colors focus:border-accent focus-visible:outline-none max-md:h-11";

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const next = safeNext(useSearchParams().get("next"));
  const me = useMe();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const errId = useId();

  // Already signed in: go straight to where the user was headed.
  useEffect(() => { if (me.data) router.replace(next); }, [me.data, next, router]);

  // Retry-After countdown after a 429.
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending || wait > 0) return;
    setPending(true);
    setError(null);
    try {
      const who = await api.login(email.trim(), password);
      qc.setQueryData(ME_KEY, who);
      router.replace(next);
    } catch (err) {
      setPassword("");
      if (err instanceof ApiRequestError && err.kind === "unauthorized") setError("Incorrect email or password.");
      else if (err instanceof ApiRequestError && err.kind === "throttled") { setWait(err.retryAfter ?? 30); setError("Too many attempts."); }
      else if (err instanceof ApiRequestError && err.kind === "validation") setError("Enter your email and password.");
      else if (err instanceof ApiRequestError && err.kind === "network") setError(err.message);
      else setError("Could not sign in right now. Try again in a moment.");
      setPending(false);
    }
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,rgba(79,95,224,0.18),transparent)]" />
      <div className="relative w-full max-w-[380px] animate-[fade-in_300ms_var(--ease)]">
        <div className="mb-8 flex justify-center"><Wordmark /></div>
        <form onSubmit={submit} noValidate className="rounded-xl border border-line bg-s1 p-6 shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-[13px] text-t2">Use your Relay operator account.</p>

          <label htmlFor="email" className="mt-5 block text-[13px] font-medium text-t2">Email</label>
          <input id="email" name="email" type="email" inputMode="email" autoComplete="username" autoFocus required className={`${FIELD} mt-1.5`} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} aria-describedby={error ? errId : undefined} placeholder="you@company.com" />

          <label htmlFor="password" className="mt-4 block text-[13px] font-medium text-t2">Password</label>
          <div className="relative mt-1.5">
            <input id="password" name="password" type={show ? "text" : "password"} autoComplete="current-password" required className={`${FIELD} pr-10`} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} aria-describedby={error ? errId : undefined} />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} className="absolute right-1 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded text-t3 transition-colors hover:text-t1 max-md:size-10">
              {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>

          <div id={errId} role="alert" aria-live="assertive" className="min-h-5">
            {error && (
              <p className="mt-3 rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">
                {error}{wait > 0 && <> Try again in <span className="tnum">{wait}s</span>.</>}
              </p>
            )}
          </div>

          <Button type="submit" variant="primary" loading={pending} disabled={wait > 0 || !email || !password} className="mt-4 w-full">
            {pending ? "Signing in" : wait > 0 ? `Wait ${wait}s` : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
