import { expect, test } from "bun:test";
import { GIVE_UP_MS, settle } from "./lib.ts";

test("the fleet counts what never arrived once, and forgets what settled", () => {
  const now = 10 * GIVE_UP_MS;
  const s = {
    // a1 arrived; a2 never did; a3 is still in time; a4 the server never took.
    answers: new Map([
      ["a1", 0],
      ["a2", now - GIVE_UP_MS],
      ["a3", now - 1000],
      ["a4", now - GIVE_UP_MS],
    ]),
    got: new Map([["a1", 1]]),
    acked: new Set(["a1", "a2", "a3"]),
    decisions: new Map([
      ["d1", true],
      ["d2", false],
      ["d3", false],
    ]),
    decidedAt: new Map([
      ["d1", 0],
      ["d2", 0],
      ["d3", now],
    ]),
  };
  expect(settle(s, now)).toEqual({ lost: 1, unseen: 1 });
  expect([...s.answers.keys()]).toEqual(["a3"]);
  expect([...s.decisions.keys()]).toEqual(["d3"]);
  expect(settle(s, now)).toEqual({ lost: 0, unseen: 0 });
});
