import { expect, test } from "bun:test";
import type { QuotaSnapshot } from "@starbridge/protocol";
import { keepLast, raise, snapshot } from "../src/quota";

const snap = (alerts: QuotaSnapshot["alerts"]): QuotaSnapshot => ({
  v: 1,
  id: "q_1",
  to: ["phone"],
  takenAt: "2026-10-05T12:00:00Z",
  providers: [
    {
      provider: "zai",
      windows: [
        {
          id: "primary",
          label: "5h",
          usedPercent: 60,
          windowMinutes: 300,
          resetsAt: "2026-10-05T13:00:00Z",
          pace: null,
        },
      ],
    },
  ],
  alerts,
});
const low = (threshold: number, resetsAt = "2026-10-05T13:00:00Z") => ({
  kind: "low" as const,
  provider: "zai",
  window: "primary",
  resetsAt,
  threshold,
});
const at = (iso: string) => new Date(iso);

test("an alert notifies once per window per reset", () => {
  const first = raise(snap([low(50)]), {}, at("2026-10-05T12:00:00Z"));
  expect(first.snap.alerts[0]?.notify).toBe(true);

  // The next snapshots still list it, without notify, even with the reset corrected a little.
  const again = raise(
    snap([low(50, "2026-10-05T13:00:07Z")]),
    first.raised,
    at("2026-10-05T12:05:00Z"),
  );
  expect(again.snap.alerts[0]?.notify).toBeUndefined();

  // A lower threshold is its own alert.
  const lower = raise(snap([low(20)]), again.raised, at("2026-10-05T12:10:00Z"));
  expect(lower.snap.alerts[0]?.notify).toBe(true);

  // Once the reset passed, the next cycle raises it again.
  const next = raise(
    snap([low(50, "2026-10-05T18:00:00Z")]),
    lower.raised,
    at("2026-10-05T13:01:00Z"),
  );
  expect(next.snap.alerts[0]?.notify).toBe(true);
  expect(Object.keys(next.raised)).toEqual(["zai/primary/low/50"]);
});

test("an alert that lapses and returns within the cycle stays raised", () => {
  const first = raise(snap([low(50)]), {}, at("2026-10-05T12:00:00Z"));
  const gone = raise(snap([]), first.raised, at("2026-10-05T12:05:00Z"));
  const back = raise(snap([low(50)]), gone.raised, at("2026-10-05T12:10:00Z"));
  expect(back.snap.alerts[0]?.notify).toBeUndefined();
});

test("a failed probe keeps the provider's last windows, marked with when they were read", () => {
  const read = snap([]).providers;
  const timedOut = { provider: "zai", windows: [], error: "Claude usage probe timed out." };
  const failed = [timedOut];
  const one = keepLast(read, {}, at("2026-10-05T12:00:00Z"));
  expect(one.providers).toEqual(read);
  const two = keepLast(failed, one.last, at("2026-10-05T12:05:00Z"));
  expect(two.providers).toEqual([
    { ...timedOut, windows: read[0]?.windows ?? [], updatedAt: "2026-10-05T12:00:00Z" },
  ]);
  // A second failure still says when the windows were read, not when they were last kept.
  const three = keepLast(failed, two.last, at("2026-10-05T12:10:00Z"));
  expect(three.providers[0]?.updatedAt).toBe("2026-10-05T12:00:00Z");
  expect(keepLast(read, three.last, at("2026-10-05T12:15:00Z")).providers).toEqual(read);
  // Once their reset passed, the kept windows go, and the failure goes out alone.
  const gone = keepLast(failed, two.last, at("2026-10-05T13:00:00Z"));
  expect(gone.providers).toEqual(failed);
  expect(gone.last).toEqual({});
  // With nothing read before, the failure goes out alone.
  expect(keepLast(failed, {}, at("2026-10-05T12:00:00Z")).providers).toEqual(failed);
});

test("stale windows raise no alert", () => {
  const read = snap([]).providers;
  const stale = [
    {
      ...read[0],
      provider: "zai",
      windows: read[0]?.windows ?? [],
      updatedAt: "2026-10-05T12:00:00Z",
    },
  ];
  const running = (p: QuotaSnapshot["providers"]) =>
    snapshot(p, ["phone"], at("2026-10-05T12:59:00Z")).alerts.length;
  expect(running(read)).toBeGreaterThan(0);
  expect(running(stale)).toBe(0);
});
