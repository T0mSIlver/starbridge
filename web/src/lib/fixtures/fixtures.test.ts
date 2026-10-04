// The fake data must stay valid protocol data, so #8 can swap it for the
// server's without touching the screens.
import { describe, expect, test } from "bun:test";
import { Answer, Decision, Member, QuotaAlert, QuotaWindow } from "@starbridge/protocol";
import { inbox } from "./decisions";
import { devices, machines } from "./devices";
import { quotas } from "./quotas";

describe("fixtures parse with the protocol schemas", () => {
  test.each(inbox.map((item) => [item.decision.id, item]))("%s", (_, item) => {
    Decision.parse(item.decision);
    if (item.answer) Answer.parse(item.answer);
  });

  test.each([...devices, ...machines].map((d) => [d.id, d]))("%s", (_, d) => {
    Member.parse({ id: d.id, role: d.role, name: d.name, boxPk: d.boxPk, signPk: d.signPk });
  });

  test.each(quotas.map((q) => [`${q.provider}/${q.window.id}`, q]))("%s", (_, q) => {
    QuotaWindow.parse(q.window);
    if (q.alert) QuotaAlert.parse(q.alert);
  });
});

test("the quota fixtures show every card state", () => {
  const out = quotas.filter((q) => q.window.pace?.willLastToReset === false);
  const unused = quotas.filter((q) => q.alert?.kind === "unused-headroom");
  const ok = quotas.filter((q) => q.window.pace?.willLastToReset && !q.alert);
  expect([out.length > 0, unused.length > 0, ok.length > 0]).toEqual([true, true, true]);
});
