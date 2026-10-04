// The faces DESIGN.md names: the Latin weight-axis cuts from Fontsource (OFL, licences beside them).
import localFont from "next/font/local";

export const sans = localFont({
  src: "../fonts/google-sans-flex-latin-wght-normal.woff2",
  weight: "1 1000",
  display: "swap",
  fallback: ["Roboto Flex", "system-ui", "-apple-system", "sans-serif"],
  variable: "--font-sans",
});

export const mono = localFont({
  src: "../fonts/google-sans-code-latin-wght-normal.woff2",
  weight: "300 800",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "monospace"],
  variable: "--font-mono",
});
