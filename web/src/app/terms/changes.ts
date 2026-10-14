import type { LegalChange } from "@/lib/legalChanges";

/**
 * What /terms promises under "Changes": each change is posted with a new date. Newest first.
 * Add an entry here for every edit to page.tsx, dated that day: the page's "Last updated" line is
 * the first entry's date, and changes.test.ts fails while `pageHash` doesn't match page.tsx.
 */
export const termsChanges: readonly LegalChange[] = [
  { date: "2026-10-14", text: "Added this list of changes." },
  {
    date: "2026-10-07",
    text: "The service relays decisions and answers, permission prompts, runs and quota windows.",
  },
  { date: "2026-10-06", text: "Contact is privacy@starbridge.run." },
  {
    date: "2026-10-05",
    text: "First published, with the operator, the notice before any price, the appeal process, the liability limits, the notice before a shutdown and the governing law.",
  },
];

/** SHA-256 of page.tsx with its whitespace collapsed (sourceHash); changes.test.ts recomputes it. */
export const pageHash = "1c252163dd3d05f70fa64aa2e05006e3a075d2898ed7fd983af8be37d6d0d907";
