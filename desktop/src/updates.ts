import { CHANNELS, type Channel, channelOf, newerVersion, tipOffered } from "./releases";

/**
 * Where an update stands, which the page shows at the foot of its rail (#1398): nothing while
 * idle or checking, then the version found, the download's progress, and Restart to update. A
 * failed download says why until the next check; a failed check only logs, since it may be the
 * network and a check comes again.
 */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

/** What the page may ask of the updater. */
export type UpdateAction = "check" | "download" | "install";
const ACTIONS: UpdateAction[] = ["check", "download", "install"];

export const parseUpdateAction = (x: unknown): UpdateAction | null =>
  ACTIONS.includes(x as UpdateAction) ? (x as UpdateAction) : null;

/** The owner's update settings, in Settings → Updates. */
export interface UpdateSettings {
  /** Finals only, rcs too (#1071), or every build of main too (#1692). */
  channel: Channel;
  /** Whether a release found downloads at once; off, the rail's button downloads it. */
  autoDownload: boolean;
}

/**
 * What the page reads: the settings; `releaseCandidates`, the switch of pages from before the
 * channel, on for "rc" and "tip"; and `ahead`, whether the installed version waits for the
 * channel to pass it, which an update found or downloaded says it has.
 */
export interface UpdateSettingsView extends UpdateSettings {
  releaseCandidates: boolean;
  ahead: boolean;
  /** Whether Tip is offered: on a tip build, or while on Tip (releases.ts, tipOffered). */
  tip: boolean;
}

/**
 * The settings after the page's change, for the running app's `version`: Tip only where it is
 * offered, so only an app installed from a tip build gets there.
 */
export function changeUpdateSettings(
  now: UpdateSettings,
  change: Partial<UpdateSettings>,
  version: string,
): UpdateSettings {
  const next = { ...now, ...change };
  return next.channel === "tip" && !tipOffered(version, now.channel)
    ? { ...next, channel: now.channel }
    : next;
}

/**
 * A change to them from the page: `channel` or `autoDownload`, or from a page before the channel,
 * `releaseCandidates`, which on means "rc" and off "stable".
 */
export function parseUpdateSettings(x: unknown): Partial<UpdateSettings> | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const { channel, releaseCandidates, autoDownload } = x as Record<string, unknown>;
  const out: Partial<UpdateSettings> = {};
  if (channel !== undefined) {
    if (!CHANNELS.includes(channel as Channel)) return null;
    out.channel = channel as Channel;
  } else if (releaseCandidates !== undefined) {
    if (typeof releaseCandidates !== "boolean") return null;
    out.channel = releaseCandidates ? "rc" : "stable";
  }
  if (autoDownload !== undefined) {
    if (typeof autoDownload !== "boolean") return null;
    out.autoDownload = autoDownload;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** What the flow needs of electron-updater (src/updater.ts). */
export interface Engine {
  /** The newer version the followed release offers, or null. */
  find(channel: Channel): Promise<string | null>;
  /** Downloads what `find` found; resolves once it can install, rejects on failure or cancel. */
  download(progress: (percent: number) => void): { done: Promise<void>; cancel(): void };
  /** Quits and installs. */
  install(): void;
}

/**
 * The update flow: one check, download or install at a time, each change told to `tell`. Checks go
 * on while an update is offered or downloaded, so Update always installs the newest release
 * (#1444): an app that downloaded 0.1.6-rc.1 before rc.2 came out installed rc.1.
 */
export class Updates {
  status: UpdateStatus = { state: "idle" };
  private cancel: (() => void) | null = null;
  private looking = false;
  /** A click on Update during a check, which downloads once the check has settled. */
  private clicked = false;

  constructor(
    private engine: Engine,
    private settings: () => UpdateSettings,
    private tell: (s: UpdateStatus) => void,
  ) {}

  act(a: UpdateAction): void {
    if (a === "check") this.check();
    else if (a === "download") this.download();
    else if (this.status.state === "ready") this.engine.install();
  }

  async check(): Promise<void> {
    const { channel } = this.settings();
    const s = this.status;
    // Moving to a lower channel drops a release it does not offer, found or downloading. One
    // downloaded stays: Squirrel has taken it, and installs it on quit. A check under way drops
    // it itself, once it sees the new settings.
    if (
      !this.looking &&
      (s.state === "available" || s.state === "downloading") &&
      CHANNELS.indexOf(channelOf(s.version)) > CHANNELS.indexOf(channel)
    ) {
      this.cancel?.();
      this.cancel = null;
      this.set({ state: "idle" });
    }
    if (this.looking || this.status.state === "downloading") return;
    const before = this.status;
    // An update offered or downloaded keeps its button while the check runs.
    const held = before.state === "available" || before.state === "ready" ? before : null;
    if (!held) this.set({ state: "checking" });
    this.looking = true;
    let version: string | null;
    try {
      version = await this.engine.find(channel);
    } catch (e) {
      console.warn("update:", e instanceof Error ? e.message : e);
      this.looking = false;
      this.set(held ?? { state: "idle" });
      return this.settle();
    }
    this.looking = false;
    // The owner changed the settings while it looked: their check returned at once, so this
    // one answers with what they say now.
    const now = this.settings();
    if (now.channel !== channel) {
      this.status = before;
      return this.check();
    }
    if (held?.state === "ready") {
      // Squirrel installs the downloaded update on quit; only a newer release replaces it.
      if (!version || !newerVersion(version, held.version)) return this.settle();
    } else if (!version) {
      this.set({ state: "idle" });
      return this.settle();
    }
    // The engine now downloads what this check found, so the offer follows it.
    if (held?.version !== version) this.set({ state: "available", version });
    if (now.autoDownload) this.download();
    else this.settle();
  }

  /** Downloads the version found; turning automatic downloads on downloads one waiting too. */
  download(): void {
    const s = this.status;
    if (s.state !== "available") return;
    // A check may be about to offer a newer release than the one shown.
    if (this.looking) {
      this.clicked = true;
      return;
    }
    this.clicked = false;
    const { version } = s;
    this.set({ state: "downloading", version, percent: 0 });
    const run = this.engine.download((p) => {
      const percent = Math.max(0, Math.min(100, Math.floor(p)));
      const now = this.status;
      if (now.state === "downloading" && now.version === version && now.percent !== percent)
        this.set({ ...now, percent });
    });
    this.cancel = run.cancel;
    run.done.then(
      () => {
        if (this.cancel !== run.cancel) return;
        this.cancel = null;
        this.set({ state: "ready", version });
      },
      (e) => {
        // Cancelled: the check that cancelled it has moved on.
        if (this.cancel !== run.cancel) return;
        this.cancel = null;
        this.set({ state: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  /** Downloads what the owner clicked during the check that just ended. */
  private settle(): void {
    if (this.clicked) this.download();
    this.clicked = false;
  }

  private set(s: UpdateStatus): void {
    this.status = s;
    this.tell(s);
  }
}
