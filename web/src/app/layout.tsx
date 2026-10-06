import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { THEME_SCRIPT, ZOD_SCRIPT } from "@/lib/themeScript";
import { mono, sans } from "@/styles/fonts";
import "@/styles/tokens.css";
import "@/styles/type.css";
import "./globals.css";

export const metadata: Metadata = {
  // The app name first: an installed desktop app's window shows a title that starts with it
  // as is, where Chrome would prefix "Starbridge - " to "Quotas · Starbridge".
  title: { default: "Starbridge", template: "Starbridge · %s" },
  description: "Your AI quota windows and the decisions your agents need from you.",
  // iOS runs the page from the Home Screen without Safari's bars. The "default" status bar
  // keeps the clock readable in both schemes, where "black-translucent" draws white text.
  appleWebApp: { capable: true, title: "Starbridge", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  viewportFit: "cover",
  // DESIGN.md's `bg` in each scheme: the browser bar, and an installed app's title bar.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f4" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0c" },
  ],
};

// Every page renders per request, so each gets the nonce of its Content-Security-Policy (proxy.ts).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* The Colours setting, before the first paint (lib/prefs.ts). */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script from our own module */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script from our own module */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: ZOD_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
