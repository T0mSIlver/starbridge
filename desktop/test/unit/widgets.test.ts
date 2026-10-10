import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageState } from "../../src/bridge";
import { snapshot, Widgets } from "../../src/widgets";

const state = (s: Partial<PageState>): PageState => ({
  count: 3,
  entries: [],
  waiting: 1,
  account: "ready",
  ...s,
});

test("the widget counts what the page counts, says signed out, and keeps its count while loading", () => {
  expect(snapshot(state({}))).toEqual({ state: "ready", open: 3, waiting: 1 });
  expect(snapshot(state({ account: "signedOut", count: 0, waiting: 0 }))).toEqual({
    state: "signedOut",
    open: 0,
    waiting: 0,
  });
  expect(snapshot(state({ account: "loading" }))).toBeNull();
});

test("the helper runs once per new snapshot, and on quit says the app is closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "widgets-"));
  const log = join(dir, "log");
  const helper = join(dir, "starbridge-widgets");
  writeFileSync(helper, `#!/bin/sh\n{ cat; echo; } >> ${log}\n`);
  chmodSync(helper, 0o755);
  const widgets = new Widgets(helper);
  widgets.show(snapshot(state({})));
  widgets.show(snapshot(state({})));
  widgets.show(snapshot(state({ account: "loading" })));
  widgets.show(snapshot(state({ waiting: 0 })));
  await new Promise((r) => setTimeout(r, 300));
  widgets.close();
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    '{"state":"ready","open":3,"waiting":1}',
    '{"state":"ready","open":3,"waiting":0}',
    '{"state":"closed","open":0,"waiting":0}',
  ]);
});
