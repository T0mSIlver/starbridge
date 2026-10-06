import type { Database } from "bun:sqlite";
import type { Caller } from "./auth";

/**
 * Daily usage counts, from requests the server handles anyway. During a day, `usage_events`
 * holds one row per event; `closeDays` folds each finished day into counts and percentiles in
 * `usage_days` and deletes its events, so no row naming an account or member outlives its day.
 *
 * An event's metric names what happened. With a subject (an account id, or an account and member id), the day's
 * count is of distinct subjects; without, of events. Events that carry a value (seconds to
 * answer) also give `<metric>.p50` and `<metric>.p90`.
 */
export class Usage {
  /** Subjects already recorded today, so a request that changes nothing writes nothing. */
  private seenToday = new Set<string>();
  private today = "";

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  record(metric: string, subject: string | null = null, value: number | null = null): void {
    const day = dayOf(this.now());
    if (subject !== null) {
      if (day !== this.today) {
        this.today = day;
        this.seenToday.clear();
      }
      const key = `${metric}\n${subject}`;
      if (this.seenToday.has(key)) return;
      this.seenToday.add(key);
    }
    // Counting is never worth failing a request: on a full disk the event is dropped, after
    // whatever the request stored has committed.
    try {
      this.db
        .query(
          "INSERT OR IGNORE INTO usage_events (day, metric, subject, value) VALUES (?, ?, ?, ?)",
        )
        .run(day, metric, subject, value);
    } catch (e) {
      if (!diskFull(e)) throw e;
    }
  }

  /**
   * Marks the caller's account, and its machine or paired device, active today. Member ids are
   * unique only within an account, so a member's subject names both.
   */
  seen(caller: Caller): void {
    this.record("active.accounts", caller.account);
    if (caller.member === null) return;
    const member = `${caller.account}/${caller.member}`;
    if (caller.role === "machine") this.record("active.machines", member);
    else this.record(`active.devices.${caller.client}`, member);
  }
}

/** SQLite's answer to a write that found no room on the disk. */
export function diskFull(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "SQLITE_FULL";
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

/** One day's counts, from its events and from what the server holds now. */
export function aggregate(db: Database, day: string): Record<string, number> {
  const out: Record<string, number> = {};
  const metrics = db
    .query(
      `SELECT metric, COUNT(DISTINCT subject) AS subjects, COUNT(*) AS events
       FROM usage_events WHERE day = ? GROUP BY metric`,
    )
    .all(day) as { metric: string; subjects: number; events: number }[];
  for (const m of metrics) {
    out[m.metric] = m.subjects > 0 ? m.subjects : m.events;
    const values = (
      db
        .query(
          "SELECT value FROM usage_events WHERE day = ? AND metric = ? AND value IS NOT NULL ORDER BY value",
        )
        .all(day, m.metric) as { value: number }[]
    ).map((r) => r.value);
    if (values.length > 0) {
      out[`${m.metric}.p50`] = percentile(values, 50);
      out[`${m.metric}.p90`] = percentile(values, 90);
    }
  }
  // Totals as the server holds them when the day is counted.
  const totals = db
    .query(
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
       (SELECT COUNT(*) FROM accounts WHERE substr(created_at, 1, 10) = ?) AS new_accounts,
       (SELECT COUNT(*) FROM members WHERE active = 1 AND role = 'machine') AS machines,
       (SELECT COUNT(*) FROM members WHERE active = 1 AND role = 'device') AS devices`,
    )
    .get(day) as { accounts: number; new_accounts: number; machines: number; devices: number };
  out["total.accounts"] = totals.accounts;
  out["new.accounts"] = totals.new_accounts;
  out["total.machines"] = totals.machines;
  out["total.devices"] = totals.devices;
  const subs = db
    .query("SELECT type, COUNT(*) AS n FROM push_subscriptions GROUP BY type")
    .all() as { type: string; n: number }[];
  for (const s of subs) out[`total.push-targets.${s.type}`] = s.n;
  return out;
}

/** Folds every day before today into `usage_days` and deletes its events. */
export function closeDays(db: Database, now = Date.now()): void {
  const today = dayOf(now);
  const days = db
    .query("SELECT DISTINCT day FROM usage_events WHERE day < ? ORDER BY day")
    .all(today) as { day: string }[];
  const put = db.query("INSERT OR REPLACE INTO usage_days (day, metric, value) VALUES (?, ?, ?)");
  for (const { day } of days)
    db.transaction(() => {
      for (const [metric, value] of Object.entries(aggregate(db, day))) put.run(day, metric, value);
      db.query("DELETE FROM usage_events WHERE day = ?").run(day);
    })();
}

/** The last `days` days, oldest first: closed days as stored, the rest counted from events. */
export function report(
  db: Database,
  days: number,
  now = Date.now(),
): { day: string; metrics: Record<string, number> }[] {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * 86_400_000);
    const stored = db.query("SELECT metric, value FROM usage_days WHERE day = ?").all(day) as {
      metric: string;
      value: number;
    }[];
    const open = db.query("SELECT 1 FROM usage_events WHERE day = ? LIMIT 1").get(day);
    // A closed day with no events was a day the server did not run; it has no counts.
    const metrics =
      stored.length > 0 && !open
        ? Object.fromEntries(stored.map((r) => [r.metric, r.value]))
        : open || i === 0
          ? aggregate(db, day)
          : {};
    out.push({ day, metrics });
  }
  return out;
}

/** A table with one row per metric and one column per day. */
export function formatReport(rows: ReturnType<typeof report>): string {
  const metrics = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))].sort();
  const width = Math.max(6, ...metrics.map((m) => m.length));
  const head = ["".padEnd(width), ...rows.map((r) => r.day.slice(5).padStart(6))].join(" ");
  const lines = metrics.map((m) =>
    [
      m.padEnd(width),
      ...rows.map((r) => {
        const v = r.metrics[m];
        return (v === undefined ? "-" : String(Number.isInteger(v) ? v : v.toFixed(1))).padStart(6);
      }),
    ].join(" "),
  );
  return [head, ...lines].join("\n");
}
