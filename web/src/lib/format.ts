import { getPref, type Prefs } from "./prefs";

/** "4 min ago", "in 2 h 30 min", "in 3 days". */
export function relative(iso: string, now: Date = new Date()): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  const span = Math.abs(minutes);
  let text: string;
  if (span < 1) return "now";
  if (span < 60) text = `${span} min`;
  else if (span < 24 * 60) {
    const h = Math.floor(span / 60);
    const m = span % 60;
    text = m ? `${h} h ${m} min` : `${h} h`;
  } else {
    const d = Math.round(span / (24 * 60));
    text = `${d} day${d === 1 ? "" : "s"}`;
  }
  return minutes < 0 ? `${text} ago` : `in ${text}`;
}

/** A session id short enough to read: the first 8 characters of a UUID, other ids whole. */
export function shortSession(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f-]+$/i.test(id) ? id.slice(0, 8) : id;
}

/** The session's title, else its short id. */
export function sessionName(source: { session: string; sessionTitle?: string }): string {
  return source.sessionTitle || shortSession(source.session);
}

/** Where a decision comes from, in a list row: its session, else its project (asked outside a session). */
export function origin(source: {
  session: string;
  sessionTitle?: string;
  project: string;
}): string {
  return sessionName(source) || source.project;
}

/** "14:30" or "02:30 PM": the Clock setting, else the browser's language. */
export function clockTime(d: Date, clock: Prefs["clock"] = getPref("clock")): string {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(clock === "system" ? {} : { hour12: clock === "12" }),
  });
}

/** "Oct 7, 14:20": the day, and the time in the Clock setting. */
export function dayAndTime(iso: string, clock: Prefs["clock"] = getPref("clock")): string {
  const at = new Date(iso);
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clockTime(at, clock)}`;
}

/**
 * "added Oct 6" for each row, keyed by id; a row whose name another shares, such as a machine
 * paired again, adds the time so the two read apart (#287).
 */
export function addedLabels(
  rows: { id: string; name: string; addedAt: string }[],
  clock: Prefs["clock"] = getPref("clock"),
): Map<string, string> {
  const named = new Map<string, number>();
  for (const r of rows) named.set(r.name, (named.get(r.name) ?? 0) + 1);
  return new Map(
    rows.map((r) => {
      const at = new Date(r.addedAt);
      // One unit on the row: "Oct 6" never leaves its day alone on the next line.
      const day = at
        .toLocaleDateString(undefined, { day: "numeric", month: "short" })
        .replaceAll(" ", "\u00a0");
      const twin = (named.get(r.name) ?? 0) > 1;
      return [r.id, `added ${day}${twin ? `, ${clockTime(at, clock)}` : ""}`];
    }),
  );
}
