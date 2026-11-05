import Link from "next/link";
import { Wordmark } from "../components/brand";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="text-center">
        <Wordmark />
        <h1 className="mt-8 text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-t2">That page does not exist or has moved.</p>
        <Link href="/" className="mt-6 inline-flex min-h-9 items-center rounded-md border border-line-strong bg-s2 px-3 text-[13px] font-medium hover:bg-s3">Back to tickets</Link>
      </div>
    </main>
  );
}
