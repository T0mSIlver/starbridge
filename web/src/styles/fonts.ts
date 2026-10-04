// The faces DESIGN.md names, copied from vidtheque (OFL, licences beside them).
import localFont from "next/font/local";

export const sans = localFont({
  src: "../fonts/archivo-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "sans-serif"],
  variable: "--font-sans",
});

export const mono = localFont({
  src: "../fonts/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "monospace"],
  variable: "--font-mono",
});
