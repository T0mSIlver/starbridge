// notifyStep against vectors/rules.json's notify cases, which the clients' tests run too (#2151).
import { expect, test } from "bun:test";
import { type Notified, type NotifyEvent, notifyStep } from "../src/notify";
import rules from "../vectors/rules.json";

type Step = { restart: true } | { push: NotifyEvent & { id: string }; effect: string };

test.each(rules.notify.map((c) => [c.name, c] as const))("%s", (_, c) => {
  let kept: Notified = {};
  for (const step of c.steps as unknown as Step[]) {
    // What a client keeps survives as JSON.
    if ("restart" in step) kept = JSON.parse(JSON.stringify(kept));
    else {
      const next = notifyStep(kept, step.push);
      expect(`${step.push.kind} ${next.effect}`).toBe(`${step.push.kind} ${step.effect}`);
      kept = next.kept;
    }
  }
});
