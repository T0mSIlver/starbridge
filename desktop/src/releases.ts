const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-(rc|tip)\.(\d+))?$/;

/** Where an app gets its updates (#1692): finals only, rcs too, or every build of main too. */
export type Channel = "stable" | "rc" | "tip";
export const CHANNELS: readonly Channel[] = ["stable", "rc", "tip"];

/** An rc, then a tip build, then the final, as semver orders them ("rc" < "tip" as text). */
const KIND = { rc: 0, tip: 1 } as const;

/** A tag's parts, a final after its rcs and tip builds; null for a tag that is not a release's. */
function parts(tag: string): number[] | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  const kind = m[4] ? KIND[m[4] as keyof typeof KIND] : 2;
  return [Number(m[1]), Number(m[2]), Number(m[3]), kind, m[5] ? Number(m[5]) : 0];
}

function newer(a: number[], b: number[]): boolean {
  const i = a.findIndex((x, j) => x !== b[j]);
  return i !== -1 && (a[i] ?? 0) > (b[i] ?? 0);
}

/** Whether release version `a` ("0.1.6-rc.2", no "v") is newer than `b`; false when either is not a release's. */
export function newerVersion(a: string, b: string): boolean {
  const x = parts(`v${a}`);
  const y = parts(`v${b}`);
  return !!x && !!y && newer(x, y);
}

/** The lowest channel that offers this version: an rc's is "rc", a tip build's "tip". */
export function channelOf(version: string): Channel {
  return version.includes("-tip.") ? "tip" : version.includes("-rc.") ? "rc" : "stable";
}

/**
 * Whether the installed version is above what `channel` offers, so the app stays on it until the
 * channel passes it: electron-updater never downgrades.
 */
export const ahead = (installed: string, channel: Channel): boolean =>
  CHANNELS.indexOf(channelOf(installed)) > CHANNELS.indexOf(channel);

/**
 * Whether Settings offers Tip (#1692): only to the owner, who gets there by installing a tip build
 * once, and keeps it while on Tip, even when a final or rc passed his build.
 */
export const tipOffered = (installed: string, channel: Channel): boolean =>
  channelOf(installed) === "tip" || channel === "tip";

/** The release tags a GitHub releases Atom feed links to. */
export function feedTags(atom: string): string[] {
  return [...atom.matchAll(/\/releases\/tag\/([^"<\s]+)/g)].map((m) =>
    decodeURIComponent(m[1] ?? ""),
  );
}

/**
 * The release this app follows (#1071, #1692), as a tag: the latest final, GitHub's latest
 * release; on "rc" or "tip", the newest rc when it is newer; on "tip", the tip build
 * (`v` + `tip`, its version) when it is newer still. Only rc tags count from the feed, so a final
 * withdrawn by marking it a prerelease (v0.1.3) reaches no one. electron-updater's own GitHub
 * lookup keeps an app installed from an rc on rcs and never offers it a final, so the app picks
 * the release itself.
 */
export function pickRelease(
  latest: string | null,
  tags: string[],
  channel: Channel,
  tip: string | null = null,
): string | null {
  let best = latest && parts(latest)?.[3] === 2 ? latest : null;
  const offer = (tag: string, kind: number) => {
    const v = parts(tag);
    if (!v || v[3] !== kind) return;
    const b = best && parts(best);
    if (!b || newer(v, b)) best = tag;
  };
  if (channel === "stable") return best;
  for (const tag of tags) offer(tag, KIND.rc);
  if (channel === "tip" && tip) offer(`v${tip}`, KIND.tip);
  return best;
}

/** The version a release's latest-mac.yml names; null when it names none. */
export const ymlVersion = (yml: string): string | null =>
  /^version:\s*['"]?([^'"\s]+)/m.exec(yml)?.[1] ?? null;

/**
 * Where electron-updater reads the release `pickRelease` named: the tip build from the one
 * release `tip` of the tip repository, any other tag from the releases repository.
 */
export const feedUrl = (tag: string, releases: string, tip: string): string =>
  tag.includes("-tip.") ? `${tip}/releases/download/tip/` : `${releases}/releases/download/${tag}/`;
