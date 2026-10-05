import { beforeAll, expect, test } from "bun:test";
import {
  checkPermissionAnswer,
  hashInput,
  type Permission,
  type PermissionAnswer,
  ready,
} from "../src/index";

let asked: Permission;
let answer: PermissionAnswer;

beforeAll(async () => {
  await ready;
  const input = '{"command":"git push"}';
  asked = {
    v: 1,
    id: "perm_1",
    to: ["phone"],
    createdAt: "2026-10-05T10:00:00Z",
    agent: "claude-code",
    tool: "Bash",
    summary: "git push",
    input,
    inputHash: hashInput(input),
    suggestions: [{ label: "This session", rule: "Bash(git push:*)", scope: "session" }],
    expiresAt: "2026-10-05T10:09:30Z",
    source: { machine: "devbox", project: "p", session: "s" },
  };
  answer = {
    v: 1,
    id: "pa_1",
    permissionId: "perm_1",
    to: "devbox",
    answeredAt: "2026-10-05T10:01:00Z",
    behavior: "allow",
    scope: "session",
    inputHash: asked.inputHash,
  };
});

const at = Date.parse("2026-10-05T10:01:00Z");
const code = (f: () => void) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

test("an answer that repeats the hash and picks an offered scope passes", () => {
  expect(code(() => checkPermissionAnswer(asked, answer, "phone", at))).toBe("ok");
  expect(code(() => checkPermissionAnswer(asked, { ...answer, scope: "once" }, "phone", at))).toBe(
    "ok",
  );
});

test("the machine refuses answers that do not bind to what it asked", () => {
  const cases: [Partial<PermissionAnswer>, string, number, string][] = [
    [{ inputHash: hashInput('{"command":"rm -rf /"}') }, "phone", at, "wrong-input"],
    [{ scope: "project" }, "phone", at, "scope-not-offered"],
    [{ permissionId: "perm_2" }, "phone", at, "id-mismatch"],
    [{}, "phone2", at, "signer-not-allowed"],
    [{}, "phone", Date.parse("2026-10-05T10:09:31Z"), "expired"],
  ];
  for (const [change, device, now, want] of cases)
    expect(code(() => checkPermissionAnswer(asked, { ...answer, ...change }, device, now))).toBe(
      want,
    );
});
