import { expect, test } from "bun:test";
import type { InboxItem } from "./types";
import { withUnsent } from "./unsent";

const item = (id: string, answeredAt?: string) =>
  ({ decision: { id }, ...(answeredAt ? { answeredAt } : {}) }) as unknown as InboxItem;

test("an unsent answer closes its question, a refused one reopens it with why (#895)", () => {
  const at = "2026-10-09T10:00:00Z";
  const [sent, refused, open] = withUnsent(
    [item("d_sent"), item("d_refused"), item("d_open")],
    { d_sent: { reply: { choice: "Ship" }, at } },
    { d_refused: "bad-schema" },
  );
  expect(sent).toMatchObject({ answeredAt: at, reply: { choice: "Ship" }, sending: true });
  expect(refused).toMatchObject({ notSent: "bad-schema" });
  expect(refused?.answeredAt).toBeUndefined();
  expect(open).toEqual(item("d_open"));
});

test("an item the server lists answered keeps the server's state", () => {
  const answered = item("d_x", "2026-10-09T09:00:00Z");
  const [shown] = withUnsent(
    [answered],
    { d_x: { reply: { choice: "Hold" }, at: "2026-10-09T10:00:00Z" } },
    {},
  );
  expect(shown).toBe(answered);
});
