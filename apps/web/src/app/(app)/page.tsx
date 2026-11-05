import type { Metadata } from "next";
import { Suspense } from "react";
import { Board } from "../../components/board";

export const metadata: Metadata = { title: "Tickets" };

export default function TicketsPage() {
  return <Suspense><Board /></Suspense>;
}
