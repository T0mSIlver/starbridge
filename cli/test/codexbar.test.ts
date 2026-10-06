import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collect, parseUsage, type RunResult, shortError } from "../src/codexbar";
import { snapshot } from "../src/quota";

// The fixtures were recorded at 19:09 UTC.
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

test("a provider that fails is asked once more before its failure counts", async () => {
  const timedOut = JSON.stringify([
    { provider: "claude", error: { message: "Claude usage probe timed out." } },
  ]);
  const ok = JSON.stringify([{ provider: "claude", usage: { primary: { usedPercent: 40 } } }]);
  const calls: (string | undefined)[] = [];
  const replies: RunResult[] = [
    { code: 1, stdout: timedOut, stderr: "" },
    { code: 0, stdout: ok, stderr: "" },
    { code: 1, stdout: timedOut, stderr: "" },
    { code: 1, stdout: timedOut, stderr: "" },
  ];
  const run = async (_bin: string, p: string | undefined) => {
    calls.push(p);
    return replies.shift() as RunResult;
  };
  const log: string[] = [];
  const round = () =>
    collect(
      "codexbar",
      ["claude"],
      () => NOW,
      (l) => log.push(l),
      run,
    );
  const first = await round();
  expect(first.map((r) => [r.windows.length, r.error])).toEqual([[1, undefined]]);
  expect(log).toEqual(["codexbar claude: Claude usage probe timed out.; retrying"]);
  const second = await round();
  expect(second.map((r) => r.error)).toEqual(["Claude usage probe timed out."]);
  expect(log.at(-1)).toBe("codexbar claude: Claude usage probe timed out.");
  expect(calls).toEqual(["claude", "claude", "claude", "claude"]);
});

test("providers are read at once, and their rows keep the order asked", async () => {
  let open = 0;
  let most = 0;
  const run = async (_bin: string, p: string | undefined): Promise<RunResult> => {
    open++;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, p === "claude" ? 30 : 10));
    open--;
    const row = { provider: p, usage: { primary: { usedPercent: 10 } } };
    return { code: 0, stdout: JSON.stringify([row]), stderr: "" };
  };
  const rows = await collect(
    "codexbar",
    ["claude", "codex", "zai"],
    () => NOW,
    () => {},
    run,
  );
  expect(most).toBe(3);
  expect(rows.map((r) => r.provider)).toEqual(["claude", "codex", "zai"]);
});

test("devices get a provider's error short; the log keeps it whole", async () => {
  const raw = 'Mistral API error: HTTP 500: {"detail":"Internal server error"}';
  const failed: RunResult = {
    code: 1,
    stdout: JSON.stringify([{ provider: "mistral", error: { message: raw } }]),
    stderr: "",
  };
  const log: string[] = [];
  const rows = await collect(
    "codexbar",
    ["mistral"],
    () => NOW,
    (l) => log.push(l),
    async () => failed,
  );
  expect(rows.map((r) => r.error)).toEqual(["Mistral's usage API failed (500)"]);
  expect(log.at(-1)).toBe(`codexbar mistral: ${raw}`);
  expect(shortError("Claude usage probe timed out.")).toBe("Claude usage probe timed out.");
  expect(shortError("timed out (<30s)")).toBe("timed out (<30s)");
  expect(shortError("unexpected reply: <html><body>Bad gateway</body></html>")).toBe(
    "unexpected reply",
  );
});

test("a run that hung is not asked again, and a run for every provider that fails posts nothing", async () => {
  const replies: RunResult[] = [
    { code: null, stdout: "", stderr: "" },
    { code: 2, stdout: "", stderr: "boom" },
    { code: 2, stdout: "", stderr: "boom" },
  ];
  let calls = 0;
  const run = async () => {
    calls++;
    return replies.shift() as RunResult;
  };
  const hung = await collect(
    "codexbar",
    ["claude"],
    () => NOW,
    () => {},
    run,
  );
  expect(hung.map((r) => r.error)).toEqual(["exited on a signal"]);
  expect(calls).toBe(1);
  await expect(
    collect(
      "codexbar",
      [],
      () => NOW,
      () => {},
      run,
    ),
  ).rejects.toThrow("codexbar: exited 2: boom");
  expect(calls).toBe(3);
});
