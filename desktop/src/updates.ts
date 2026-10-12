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
  /** Whether updates include release candidates, not only finals (#1071). */
  releaseCandidates: boolean;
  /** Whether a release found downloads at once; off, the rail's button downloads it. */
  autoDownload: boolean;
}

/** A change to them from the page: either field, booleans only. */
export function parseUpdateSettings(x: unknown): Partial<UpdateSettings> | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const out: Partial<UpdateSettings> = {};
  for (const key of ["releaseCandidates", "autoDownload"] as const) {
    const v = (x as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return null;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** What the flow needs of electron-updater (src/updater.ts). */
export interface Engine {
  /** The newer version the followed release offers, or null. */
  find(rcs: boolean): Promise<string | null>;
  /** Downloads what `find` found; resolves once it can install, rejects on failure or cancel. */
  download(progress: (percent: number) => void): { done: Promise<void>; cancel(): void };
  /** Quits and installs. */
  install(): void;
}

/** The update flow: one check, download or install at a time, each change told to `tell`. */
export class Updates {
  status: UpdateStatus = { state: "idle" };
  private cancel: (() => void) | null = null;

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
    const { releaseCandidates: rcs } = this.settings();
    const s = this.status;
    // Turning release candidates off drops an rc found or downloading. One downloaded stays:
    // Squirrel has taken it, and installs it on quit.
    if ((s.state === "available" || s.state === "downloading") && rc(s.version) && !rcs) {
      this.cancel?.();
      this.cancel = null;
      this.set({ state: "idle" });
    }
    if (this.status.state === "checking" || this.status.state === "downloading") return;
    if (this.status.state === "ready") return;
    const before = this.status;
    this.set({ state: "checking" });
    let version: string | null;
    try {
      version = await this.engine.find(rcs);
    } catch (e) {
      console.warn("update:", e instanceof Error ? e.message : e);
      this.set(before.state === "available" ? before : { state: "idle" });
      return;
    }
    // The owner changed the settings while it looked: their check returned at once, so this
    // one answers with what they say now.
    const now = this.settings();
    if (now.releaseCandidates !== rcs) {
      this.status = before;
      return this.check();
    }
    if (!version) return this.set({ state: "idle" });
    this.set({ state: "available", version });
    if (now.autoDownload) this.download();
  }

  /** Downloads the version found; turning automatic downloads on downloads one waiting too. */
  download(): void {
    const s = this.status;
    if (s.state !== "available") return;
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

  private set(s: UpdateStatus): void {
    this.status = s;
    this.tell(s);
  }
}

const rc = (version: string) => version.includes("-rc.");
