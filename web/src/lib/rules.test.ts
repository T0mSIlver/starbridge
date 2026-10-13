// The web's rules against packages/protocol/vectors/rules.json, which Android's and iOS's tests
// read too (#1429). The swipe's morning is not here: the web has no swipe.
import { expect, test } from "bun:test";
import { PRESENCE_BEAT_MS, PRESENCE_INPUT_MS, PUSH_HOLD_CHOICES } from "@starbridge/protocol";
import rules from "../../../packages/protocol/vectors/rules.json";
import { ordered } from "../components/options";
import { backoff } from "./api";
import { questionNote } from "./notes";
import { ROW_INPUT_MAX } from "./permissionInput";
import { PRESENCE_CHECK_MS } from "./presence";
import { SNOOZE_MAX_MS, SNOOZE_MIN_MS, snoozePresets, snoozeTakes } from "./snooze";
import type { Decision, InboxItem } from "./types";

test("presence, retry and row limits", () => {
  expect({
    inputMs: PRESENCE_INPUT_MS,
    beatMs: PRESENCE_BEAT_MS,
    checkMs: PRESENCE_CHECK_MS,
    holdChoices: [...PUSH_HOLD_CHOICES] as number[],
  }).toEqual(rules.presence);
  expect(backoff.retryForMs).toBe(rules.retryForMs);
  expect(ROW_INPUT_MAX).toBe(rules.rowInputMax);
});

test("snooze presets and limits", () => {
  expect([SNOOZE_MIN_MS, SNOOZE_MAX_MS]).toEqual([rules.snooze.minMs, rules.snooze.maxMs]);
  for (const c of rules.snooze.presets) {
    const got = snoozePresets(new Date(c.now)).map((p) => [p.label, p.until.getTime()]);
    expect(got, c.now).toEqual(
      c.presets.map(([label, until]) => [label, new Date(until).getTime()]),
    );
  }
  for (const c of rules.snooze.allowed) {
    expect(snoozeTakes(new Date(c.until), new Date(c.now)), `${c.now} → ${c.until}`).toBe(
      c.allowed,
    );
  }
});

test("options, the recommended one first, in the detail and the notification", () => {
  for (const c of rules.options) {
    const d = { options: c.options, recommended: c.recommended } as Decision;
    expect(ordered(d), c.name).toEqual(c.ordered);
    const item = {
      decision: { ...d, question: "", context: "", source: {} },
    } as unknown as InboxItem;
    expect(questionNote(item).options, c.name).toEqual(c.ordered);
  }
});
