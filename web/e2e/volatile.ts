// What differs between two runs of the same tree: times, dates and durations, which follow the
// run's clock, and the codes and keys each run makes up. Their boxes go beside each evidence
// screenshot, and evidence.ts leaves them out of the comparison with main's.
import type { Page } from "playwright";

export type Rect = { x: number; y: number; width: number; height: number };

/** Text that follows the clock: times, dates, durations. The Android run reads it too. */
export const TIME = [
  "\\b\\d{1,2}:\\d{2}(\\s?[AP]M)?\\b",
  "\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\w*\\.?\\s\\d{1,2}\\b",
  "\\b\\d+\\s?(min|h|days?|s)\\b",
  "\\bnow\\b",
  // A reset or an answer says "tomorrow" or "today" by the time of day, which moves the text.
  "\\b(today|tomorrow|yesterday)\\b",
].join("|");

/** Runs in the page, so it carries everything it uses. */
function find({ fullPage, time }: { fullPage: boolean; time: string }): Rect[] {
  const TIME = new RegExp(time, "i");
  const CODES = [
    "check-code",
    "device-check",
    "join-digits",
    "new-recovery-key",
    "pairing-code",
    "recovery-key",
    "shown-code",
  ];
  const KEYS = ["recovery-key", "current-recovery-key"];
  const dx = fullPage ? scrollX : 0;
  const dy = fullPage ? scrollY : 0;
  const rects: Rect[] = [];
  const add = (r: DOMRect) => {
    if (r.width > 0 && r.height > 0)
      rects.push({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });
  };
  for (const id of CODES)
    for (const el of document.querySelectorAll(`[data-testid="${id}"]`))
      add(el.getBoundingClientRect());
  // QR codes of pairing codes (QrCode.tsx): their modules, inside the white square.
  for (const el of document.querySelectorAll('svg[shape-rendering="crispEdges"] > path'))
    add(el.getBoundingClientRect());
  // Fields that hold a key or code as their value, which no text node shows.
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  ))
    if (KEYS.includes(el.id) || /[0-9A-Z]{4}-[0-9A-Z]{4}/.test(el.value))
      add(el.getBoundingClientRect());
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!TIME.test(n.textContent ?? "")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    add(range.getBoundingClientRect());
  }
  return rects;
}

export function volatile(page: Page, fullPage: boolean): Promise<Rect[]> {
  return page.evaluate(find, { fullPage, time: TIME });
}
