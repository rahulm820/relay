"use client";
import { RefreshCw } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { Wordmark } from "../../components/brand";
import { Shell } from "../../components/shell";
import { Button, Skeleton } from "../../components/ui";
import { ApiRequestError } from "../../lib/api";
import { useMe } from "../../lib/hooks";

// The session cookie is HttpOnly with Path=/api, so page requests never carry it and the server cannot tell whether
// we are signed in. The guard therefore asks the API (GET /api/auth/me) and redirects to /login on 401.
function Guard({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const path = usePathname();
  const search = useSearchParams().toString();
  const unauthorized = me.error instanceof ApiRequestError && me.error.kind === "unauthorized";

  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(path + (search ? `?${search}` : ""))}`);
  }, [unauthorized, router, path, search]);

  if (me.data) return <Shell me={me.data}>{children}</Shell>;

  if (me.error && !unauthorized) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="text-center">
          <Wordmark />
          <h1 className="mt-8 text-lg font-semibold">Cannot reach the server</h1>
          <p className="mt-2 max-w-sm text-t2">{me.error instanceof ApiRequestError ? me.error.message : "Something went wrong."}</p>
          <Button className="mt-5" onClick={() => void me.refetch()}><RefreshCw className="size-4" aria-hidden /> Retry</Button>
        </div>
      </main>
    );
  }

  // Checking the session (or redirecting): a quiet skeleton of the shell, never a flash of protected content.
  return (
    <div className="flex h-screen flex-col" aria-busy="true">
      <div className="flex h-12 items-center gap-6 border-b border-line px-4"><Wordmark /><Skeleton className="h-5 w-16" /></div>
      <div className="grid flex-1 grid-cols-4 gap-3 p-4 max-lg:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return <Suspense><Guard>{children}</Guard></Suspense>;
}
