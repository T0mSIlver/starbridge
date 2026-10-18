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
    st.asked.old = ask(ago(month + 1));
    st.answers.old = { answer: { text: "yes" } as never, seen: true };
    st.asked.recent = ask(ago(month - 1));
    st.answers.recent = { answer: { text: "no" } as never, seen: false };
    st.asked.settledOld = ask(ago(month - 1), { settled: true, settledAt: ago(week + 1) });
    st.asked.settledNew = ask(ago(month - 1), { settled: true, settledAt: ago(week - 1) });
    st.asked.posting = ask(ago(month + 5), { posting: true });
    // Still owed to the server or to the agent: kept past the cutoff.
    st.asked.unposted = ask(ago(month + 5), {
      settled: true,
      settledAt: ago(week + 5),
      unposted: true,
    });
    st.asked.unread = ask(ago(month + week - 1));
    st.answers.unread = { answer: { text: "late" } as never, seen: false };
    st.asked.unannounced = ask(ago(month + 2));
    st.asked.unreadOld = ask(ago(month + week + 1));
    st.answers.unreadOld = { answer: { text: "lost" } as never, seen: false };
    st.answers.unannounced = { answer: { text: "x" } as never, seen: true, announce: true };
  });
  const st = store.state();
  expect(Object.keys(st.asked).sort()).toEqual([
    "posting",
    "recent",
    "settledNew",
    "unannounced",
    "unposted",
    "unread",
  ]);
  expect(Object.keys(st.answers).sort()).toEqual(["recent", "unannounced", "unread"]);
});
