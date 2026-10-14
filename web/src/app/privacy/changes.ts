import type { LegalChange } from "@/lib/legalChanges";

/**
 * What /privacy promises under "Changes": each change is posted with a new date. Newest first.
 * Add an entry here for every edit to page.tsx, dated that day: the page's "Last updated" line is
 * the first entry's date, and changes.test.ts fails while `pageHash` doesn't match page.tsx.
 */
export const privacyChanges: readonly LegalChange[] = [
  {
    date: "2026-10-14",
    text: "Oracle also receives the database's table definitions, which hold no data, and runs our test server, which holds made-up data. Cloudflare serves the status page.",
  },
  {
    date: "2026-10-13",
    text: "Oracle in Frankfurt keeps an encrypted copy of each nightly backup for 14 days.",
  },
  {
    date: "2026-10-11",
    text: "You delete your account in Settings, with no email to the operator.",
  },
  {
    date: "2026-10-10",
    text: "The server, not the page, sends the sign-up steps to Umami, for accounts made in the last two days in any app.",
  },
  {
    date: "2026-10-08",
    text: "Added how long notifications wait while you are at a screen, and the block list of addresses blocked for abuse.",
  },
  {
    date: "2026-10-07",
    text: "The server keeps nightly copies for 7 days, so deleted data leaves backups within 2 weeks. Added snoozed decisions and the 1000-decision limit.",
  },
  {
    date: "2026-10-06",
    text: "Added the sign-up steps in Umami, its 180-day limit, Caddy's error log, the pairing token kept for about 10 minutes, and privacy@starbridge.run as the contact.",
  },
  { date: "2026-10-05", text: "First published." },
];

/** SHA-256 of page.tsx with its whitespace collapsed (sourceHash); changes.test.ts recomputes it. */
export const pageHash = "bf4ee7a5615df60b31eb82478e5b7e36e57f71d77242ffbdce81b0f3cadba123";
