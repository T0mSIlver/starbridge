import type { Metadata, Viewport } from "next";
import { mono, sans } from "@/styles/fonts";
import "@/styles/tokens.css";
import "@/styles/type.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Starbridge", template: "%s · Starbridge" },
  description: "Your AI quota windows and the decisions your agents need from you.",
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
