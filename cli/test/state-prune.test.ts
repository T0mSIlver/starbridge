import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETENTION_DAYS } from "@starbridge/protocol";
import { type State, Store } from "../src/config";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const ask = (askedAt: string, extra: Partial<State["asked"][string]> = {}) => ({
  question: "Deploy to prod?",
  options: ["yes", "no"],
  askedAt,
  to: ["d_1"],
  sessionTitle: "Release",
  ...extra,
});

test("the state forgets a question once the server has, with its answer (#2017)", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "sb-prune-")));
  const month = RETENTION_DAYS.month;
  const week = RETENTION_DAYS.week;
  store.updateState((st) => {
    // Past the month and the week an answer that came on the last day is kept: gone.
    st.asked.old = ask(ago(month + week + 1));
    st.answers.old = { answer: { text: "yes" } as never, seen: true };
    // A device answered on day 29, this machine fetches it on day 31: still here.
    st.asked.late = ask(ago(month + 2));
    st.asked.recent = ask(ago(month - 1));
    st.answers.recent = { answer: { text: "no" } as never, seen: false };
    st.asked.settledOld = ask(ago(month - 1), { settled: true, settledAt: ago(week + 1) });
    st.asked.settledNew = ask(ago(month - 1), { settled: true, settledAt: ago(week - 1) });
    st.asked.posting = ask(ago(month + week + 5), { posting: true });
    // Its settled notice has not reached the server: kept past the cutoff.
    st.asked.unposted = ask(ago(month + 5), {
      settled: true,
      settledAt: ago(week + 5),
      unposted: true,
    });
  });
  const st = store.state();
  expect(Object.keys(st.asked).sort()).toEqual([
    "late",
    "posting",
    "recent",
    "settledNew",
    "unposted",
  ]);
  expect(Object.keys(st.answers)).toEqual(["recent"]);
});
