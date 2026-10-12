import { expect, test } from "bun:test";
import type { Stored } from "./api";
import { KEPT_ANSWERED, KEPT_LOOSE, merge } from "./kept";

const at = "2026-10-12T09:00:00Z";
const listed = (kind: string, id: string, extra: Partial<Stored> & { re?: string } = {}) =>
  ({
    item: { v: 1, kind, id, from: "m", ...(extra.re ? { re: extra.re } : {}), boxes: [] },
    cursor: "0",
    receivedAt: at,
    ...(extra.answeredAt ? { answeredAt: extra.answeredAt } : {}),
  }) as unknown as Stored;
const keys = (items: Stored[]) => items.map((s) => s.item.id);

test("an item listed again replaces the one kept, at its new place", () => {
  const old = [listed("decision", "d1"), listed("decision", "d2")];
  const read = [listed("decision", "d1", { answeredAt: at })];
  const out = merge(old, read, new Set());
  expect(keys(out)).toEqual(["d2", "d1"]);
  expect(out[1]?.answeredAt).toBe(at);
});

test("answered decisions past the cap go with their notices; open ones always stay", () => {
  const answered = Array.from({ length: KEPT_ANSWERED + 1 }, (_, i) =>
    listed("decision", `d${i}`, { answeredAt: at }),
  );
  const old = [
    listed("decision", "d_open"),
    listed("settled", "s0", { re: "d0" }),
    ...answered,
    ...Array.from({ length: KEPT_LOOSE }, (_, i) => listed("waiting", `w${i}`, { re: "d_open" })),
  ];
  const out = keys(merge(old, [], new Set()));
  expect(out).toContain("d_open");
  expect(out).not.toContain("d0");
  expect(out).not.toContain("s0");
  expect(out).toContain(`d${KEPT_ANSWERED}`);
});

test("a dropped decision goes, and its waiting state once it is not among the latest", () => {
  const old = [
    listed("waiting", "w", { re: "d" }),
    listed("decision", "d"),
    ...Array.from({ length: KEPT_LOOSE }, (_, i) => listed("decision", `x${i}`)),
  ];
  const out = keys(merge(old, [], new Set(["d"])));
  expect(out).not.toContain("d");
  expect(out).not.toContain("w");
});
