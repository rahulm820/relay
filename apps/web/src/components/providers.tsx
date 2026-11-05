"use client";
import * as T from "@radix-ui/react-tooltip";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ApiRequestError } from "../lib/api";
import { ME_KEY } from "../lib/hooks";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    // Any 401 from any call means the session ended: re-check /auth/me, and the app layout's guard redirects to
    // /login. One place for that rule, so no component has to remember it.
    const onSessionEnded = (err: unknown) => {
      if (err instanceof ApiRequestError && err.kind === "unauthorized") void client.invalidateQueries({ queryKey: ME_KEY });
    };
    const client: QueryClient = new QueryClient({
      // The `me` query is the thing being re-checked; reacting to its own 401 would loop forever.
      queryCache: new QueryCache({ onError: (err, query) => { if (query.queryKey[0] !== ME_KEY[0]) onSessionEnded(err); } }),
      mutationCache: new MutationCache({ onError: onSessionEnded }),
      defaultOptions: {
        queries: {
          retry: (n, err) => err instanceof ApiRequestError && (err.kind === "network" || err.kind === "server") && n < 2,
          refetchOnWindowFocus: true,
        },
      },
    });
    return client;
  });
  return (
    <QueryClientProvider client={client}>
      <T.Provider delayDuration={250}>{children}</T.Provider>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{ style: { background: "var(--surface-3)", border: "1px solid var(--border-strong)", color: "var(--text-1)" } }}
      />
    </QueryClientProvider>
  );
}
