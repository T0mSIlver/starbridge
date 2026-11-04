// The one route an answer takes, picked when it is asked (#2284): `ask` promises a prompt exactly
// when `routeFor` returns one, so a case where it returns one that nothing delivers is a broken
// promise. The agent's table in agent.test.ts runs these end to end.
import { expect, test } from "bun:test";
import { type Observed, type Route, routeFor } from "../src/decisions/route";
import type { AskInput } from "../src/decisions/source";

const codex = { bin: "/c/bin/codex", home: "/c" };
const antigravity = { address: "127.0.0.1:1", token: "t" };
const all: Observed = { reachable: true, modSeen: true, t3: true };

const ROWS: [string, Partial<AskInput>, Observed, Route["kind"] | undefined][] = [
  ["Codex, server up", { agent: "codex", session: "s", codex }, { ...all, t3: false }, "codex"],
  ["Codex in T3 Code", { agent: "codex", session: "s" }, all, "t3"],
  [
    "Codex, ask --wait (#2289)",
    { agent: "codex", session: "s", codex, wait: true },
    all,
    undefined,
  ],
  ["Antigravity, server up", { agent: "antigravity", session: "s", antigravity }, all, "agy"],
  [
    "Antigravity, ask --wait (#2289)",
    { agent: "antigravity", session: "s", antigravity, wait: true },
    all,
    undefined,
  ],
  ["Claude Code, mod seen", { agent: "claude-code", session: "s" }, all, "t3"],
  ["Claude Code, ask --wait", { agent: "claude-code", session: "s", wait: true }, all, undefined],
  [
    "Claude Code, held for a hook",
    { agent: "claude-code", session: "s", held: true },
    all,
    undefined,
  ],
  [
    "Pi with its extension",
    { agent: "pi", session: "s", extensionAnswers: true },
    { ...all, t3: false },
    "extension",
  ],
  // Nothing records a route without a session, so nothing would deliver it (#2289).
  ["Pi with its extension, no session", { agent: "pi", extensionAnswers: true }, all, undefined],
  [
    "opencode with its plugin, no session",
    { agent: "opencode", extensionAnswers: true },
    all,
    undefined,
  ],
  ["Codex, no session", { agent: "codex", codex }, all, undefined],
];

for (const [name, input, seen, kind] of ROWS)
  test(`routeFor: ${name}`, () => {
    const t3 = seen.t3 ? { t3: "th-1" } : {};
    expect(routeFor({ ...t3, ...input }, seen)?.kind).toBe(kind);
  });
