import { NOW } from "./now";

/** "4 min ago", "in 2 h 30 min", "in 3 days". */
export function relative(iso: string, now: Date = NOW): string {
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
