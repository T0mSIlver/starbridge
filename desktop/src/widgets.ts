/**
 * The Needs you widget's data (#1031). The widget, a WidgetKit extension in Contents/PlugIns
 * (widgets/), reads `widgets.json` from the App Group container and draws it. The app writes it
 * through `starbridge-widgets`, a helper beside its executable, which also asks WidgetKit to
 * redraw: WidgetCenter is Swift only.
 */
import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { PageState } from "./bridge";

/**
 * The container the app and the widget share. macOS lets an app outside the App Store open a
 * group container without asking only when the group starts with its Team ID, so ad hoc builds
 * have none and their widget says the app is closed.
 */
export const APP_GROUP = "3N63N7U9R3.dev.starbridge";

/** What the widget draws (widgets/NeedsYou.swift, `Snapshot`). */
export interface Snapshot {
  state: "ready" | "signedOut" | "closed";
  open: number;
  waiting: number;
}

export const CLOSED: Snapshot = { state: "closed", open: 0, waiting: 0 };

/** The page's state as the widget shows it; null while the page loads, which keeps the last one. */
export function snapshot(state: PageState): Snapshot | null {
  if (state.account === "loading") return null;
  if (state.account === "signedOut") return { state: "signedOut", open: 0, waiting: 0 };
  return { state: "ready", open: state.count, waiting: state.waiting };
}

/** Writes each new snapshot, one helper run at a time; the page repeats its state every 15 s. */
export class Widgets {
  private last = "";
  private running: ChildProcess | null = null;
  private next: string | null = null;

  /** `helper` is null where there is no widget: off macOS, or a development run. */
  constructor(private readonly helper: string | null) {}

  static at(executable: string): Widgets {
    const helper = executable.replace(/[^/]+$/, "starbridge-widgets");
    return new Widgets(process.platform === "darwin" && existsSync(helper) ? helper : null);
  }

  show(s: Snapshot | null): void {
    if (!this.helper || !s) return;
    const json = JSON.stringify(s);
    if (json === this.last) return;
    this.last = json;
    this.next = json;
    this.write();
  }

  /** On quit: the widget says Starbridge is closed rather than keep a count nobody updates. */
  close(): void {
    if (!this.helper || this.last === JSON.stringify(CLOSED)) return;
    // A write still running could rename its file over this one once the app is gone.
    this.next = null;
    this.running?.kill("SIGKILL");
    try {
      execFileSync(this.helper, [APP_GROUP], { input: JSON.stringify(CLOSED), timeout: 2_000 });
    } catch {}
  }

  private write(): void {
    if (this.running || this.next === null || !this.helper) return;
    const json = this.next;
    this.next = null;
    const child = execFile(this.helper, [APP_GROUP], { timeout: 10_000 }, () => {
      this.running = null;
      this.write();
    });
    this.running = child;
    // A helper that exits before reading (an ad hoc build, refused the group) must not crash the app.
    child.stdin?.on("error", () => {});
    child.stdin?.end(json);
  }
}
