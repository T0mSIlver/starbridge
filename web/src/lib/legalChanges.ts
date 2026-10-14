import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** One line of a legal page's Changes list. `date` is "YYYY-MM-DD". */
export type LegalChange = { date: string; text: string };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-10-14" as "14 October 2026". */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** SHA-256 of a page's source with its whitespace collapsed, for the tests that guard its Changes list. */
export function sourceHash(file: URL): string {
  const text = readFileSync(file, "utf8").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(text).digest("hex");
}
