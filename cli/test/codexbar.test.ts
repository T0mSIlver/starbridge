import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseUsage } from "../src/codexbar";
import { snapshot } from "../src/quota";

// The fixtures were recorded on the dev box at 19:09 UTC.
const NOW = new Date("2026-10-04T19:09:00Z");
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures", "codexbar", `${name}.json`), "utf8");

test("recorded output: every window, with pace and alerts", () => {
  const providers = ["codex", "zai", "claude", "mistral"].flatMap((p) =>
    parseUsage(fixture(p), p, NOW),
  );
  const windows = providers.map((p) => [p.provider, p.windows.map((w) => w.id)]);
  expect(windows).toEqual([
    ["codex", ["primary", "secondary"]],
    ["zai", ["primary", "zai-mcp"]],
    ["claude", ["primary", "secondary", "claude-weekly-scoped-fable"]],
    ["mistral", ["primary", "mistral-monthly-plan"]],
  ]);
  const claude5h = providers[2]?.windows[0];
  expect(claude5h).toMatchObject({ label: "Session", usedPercent: 18, windowMinutes: 300 });
  expect(claude5h?.pace?.stage).toBe("behind");
  // Mistral gives no window length, so no pace.
  expect(providers[3]?.windows[1]?.pace).toBeNull();

  const alerts = snapshot(providers, ["phone"], NOW).alerts;
  expect(alerts.map((a) => `${a.kind} ${a.provider} ${a.window}`)).toEqual([
    "low codex primary",
    "runs-out codex primary",
    "low codex secondary",
    "runs-out codex secondary",
    "low zai primary",
    "runs-out zai primary",
    "unused-headroom claude primary",
    "low claude secondary",
    "runs-out claude secondary",
  ]);
});

test("schema drift: unknown fields ignored, malformed windows skipped, errors kept", () => {
  const rows = parseUsage(fixture("drift"), undefined, NOW);
  expect(rows.map((r) => r.provider)).toEqual(["claude", "zai", "cursor"]);
  const [claude, zai, cursor] = rows;
  expect(claude?.windows.map((w) => [w.id, w.windowMinutes, w.resetsAt])).toEqual([
    ["primary", 300, "2026-10-04T20:00:00Z"],
    ["tertiary", null, null],
    ["opus", 10080, "2026-10-07T18:00:00Z"],
  ]);
  expect(claude?.account).toBeUndefined();
  expect(zai?.windows).toEqual([]);
  expect(cursor?.error).toBe("cookie expired");
});

test("a provider codexbar does not know is filtered out, not mislabelled", () => {
  expect(parseUsage(fixture("all"), "nosuch", NOW)).toEqual([]);
  expect(() => parseUsage('{"provider":"x"}', undefined, NOW)).toThrow("not a JSON array");
});
