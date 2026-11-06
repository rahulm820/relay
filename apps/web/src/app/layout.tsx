import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { Providers } from "../components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Relay", template: "%s · Relay" },
  description: "Client complaints in, triaged tickets out.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { themeColor: "#0b0d12", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
