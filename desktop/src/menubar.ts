import { spawn } from "node:child_process";

/**
 * The menu bar's own appearance. macOS draws the bar light or dark by the wallpaper, not by the
 * system theme, so a light Mac can have a dark bar with white icons; `nativeTheme` only knows the
 * theme. A menu bar icon that carries its own colours (the amber dot) must pick its arch from the
 * bar, so a status item's appearance is read by a short JXA script (JavaScript for Automation,
 * which ships with macOS) that prints `dark` or `light` whenever it changes (#1514).
 */
const PROBE = `
ObjC.import("AppKit");
ObjC.import("unistd");
$.NSApplication.sharedApplication;
$.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const item = $.NSStatusBar.systemStatusBar.statusItemWithLength(0);
const out = $.NSFileHandle.fileHandleWithStandardOutput;
let last = "";
while ($.getppid() > 1) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(1));
  const b = item.button;
  if (b.isNil()) continue;
  const now = ObjC.unwrap(b.effectiveAppearance.name).includes("Dark") ? "dark" : "light";
  if (now !== last) {
    last = now;
    out.writeData($(now + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
  }
}
`;

/** The tray image for the state: the template arch alone, or the amber dot on the bar's arch. */
export function trayImageName(needs: number, darkBar: boolean): string {
  if (needs === 0) return "trayTemplate";
  return darkBar ? "trayWaitingDark" : "trayWaitingLight";
}

export type Probe = {
  stdout: NodeJS.EventEmitter | null;
  kill(): unknown;
  on(event: "exit" | "error", listener: () => void): unknown;
};

/** Tells `onChange` the bar's appearance while watching; null once the probe is gone. */
export class MenuBar {
  dark: boolean | null = null;
  private probe: Probe | null = null;
  private buffer = "";
  /** The probe died: no new one until the dot goes, so a broken osascript can't loop. */
  private failed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly start: () => Probe = () =>
      spawn("osascript", ["-l", "JavaScript", "-e", PROBE], {
        stdio: ["ignore", "pipe", "ignore"],
      }),
  ) {}

  watch(on: boolean): void {
    if (!on) {
      this.stop();
      return;
    }
    if (this.probe || this.failed) return;
    const probe = this.start();
    this.probe = probe;
    probe.stdout?.on("data", (chunk) => this.read(String(chunk)));
    const gone = () => {
      if (this.probe !== probe) return;
      this.probe = null;
      this.failed = true;
      this.dark = null;
      this.onChange();
    };
    probe.on("exit", gone);
    probe.on("error", gone);
  }

  stop(): void {
    const probe = this.probe;
    this.probe = null;
    this.failed = false;
    this.dark = null;
    this.buffer = "";
    probe?.kill();
  }

  private read(text: string): void {
    const lines = (this.buffer + text).split("\n");
    this.buffer = lines.pop() ?? "";
    let dark = this.dark;
    for (const line of lines) {
      if (line.trim() === "dark") dark = true;
      else if (line.trim() === "light") dark = false;
    }
    if (dark === this.dark) return;
    this.dark = dark;
    this.onChange();
  }
}
