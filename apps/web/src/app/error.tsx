"use client";
import { Wordmark } from "../components/brand";
import { Button } from "../components/ui";

// The error object is deliberately not rendered: it could contain anything from a response.
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="text-center">
        <Wordmark />
        <h1 className="mt-8 text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-t2">The page hit an unexpected problem. Your work on the server is not affected.</p>
        <Button className="mt-6" onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
