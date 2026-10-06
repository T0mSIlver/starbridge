#!/usr/bin/env bun
/**
 * Stands in for `codexbar usage --format json` on the demo machine: Claude and Codex windows
 * whose use grows through each window and starts over at its reset.
 */
const now = Date.now();

function rateWindow(minutes: number, usedAtReset: number, offsetMinutes: number) {
  const length = minutes * 60_000;
  const start =
    Math.floor((now + offsetMinutes * 60_000) / length) * length - offsetMinutes * 60_000;
  const elapsed = (now - start) / length;
  return {
    windowMinutes: minutes,
    usedPercent: Math.round(usedAtReset * elapsed),
    resetsAt: new Date(start + length).toISOString(),
  };
}

const rows = [
  {
    provider: "claude",
    rateWindowLabels: { primary: "Session", secondary: "Weekly" },
    usage: {
      primary: rateWindow(300, 92, 40),
      secondary: rateWindow(10080, 70, 2000),
      identity: { accountEmail: "demo@starbridge.run" },
    },
  },
  {
    provider: "codex",
    rateWindowLabels: { primary: "5-hour", secondary: "Weekly" },
    usage: {
      primary: rateWindow(300, 55, 130),
      secondary: rateWindow(10080, 105, 5000),
      identity: { accountEmail: "demo@starbridge.run" },
    },
  },
];
const provider = process.argv.indexOf("--provider");
const only = provider >= 0 ? process.argv[provider + 1] : undefined;
console.log(JSON.stringify(only ? rows.filter((r) => r.provider === only) : rows));

export {};
