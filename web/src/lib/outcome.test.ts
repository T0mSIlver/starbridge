import { expect, test } from "bun:test";
import type { Settled } from "@starbridge/protocol";
import { answerPlace, promptOutcome } from "./outcome";
import type { PromptItem } from "./types";

const prompt = (more: Partial<PromptItem>) =>
  ({
    permission: { source: { machine: "devbox" }, expiresAt: "2026-10-05T10:00:00Z" },
    answeredAt: "2026-10-05T09:59:00Z",
    ...more,
  }) as PromptItem;
const byDevice = (behavior?: "allow" | "deny") =>
  ({ outcome: "device", device: "d_pixel", ...(behavior ? { behavior } : {}) }) as Settled;
const name = (id: string) => (id === "d_pixel" ? "sdk_gphone64_x86_64" : id);

// History reads "what · where", as questions do (#349).
test("a prompt says how and where it was answered", () => {
  expect(promptOutcome(prompt({ settled: byDevice("deny") }), name)).toEqual({
    outcome: "Denied",
    by: "on sdk_gphone64_x86_64",
  });
  expect(promptOutcome(prompt({ settled: byDevice("allow") }), name).outcome).toBe("Allowed");
  // An older machine doesn't say.
  expect(promptOutcome(prompt({ settled: byDevice() }), name).outcome).toBe("Answered");
  expect(promptOutcome(prompt({ reply: { behavior: "allow", scope: "session" } }), name)).toEqual({
    outcome: "Allowed for this session",
    by: "on this browser",
  });
  expect(
    promptOutcome(
      prompt({ settled: { outcome: "timeout" } as Settled, answeredAt: undefined }),
      name,
    ),
  ).toEqual({ outcome: "Timed out: left to the keyboard", by: "" });
});

test("Answer in shows the agent's title only on GitHub and a Claude artifact", () => {
  expect(answerPlace({ url: "https://evil.example/doc", title: "Design doc" })).toBe(
    "evil.example/doc",
  );
  expect(answerPlace({ url: "https://claude.ai/artifact/abc", title: "Design doc" })).toBe(
    "Design doc",
  );
  expect(answerPlace({ url: "https://claude.ai/artifact/abc" })).toBe("the artifact");
});
