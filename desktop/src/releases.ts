const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

/** A tag's parts, a final after its rcs; null for a tag that is not a release's. */
function parts(tag: string): number[] | null {
  const m = TAG.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : Infinity] : null;
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

/** The release tags a GitHub releases Atom feed links to. */
export function feedTags(atom: string): string[] {
  return [...atom.matchAll(/\/releases\/tag\/([^"<\s]+)/g)].map((m) =>
    decodeURIComponent(m[1] ?? ""),
  );
}

/**
 * The release this app follows (#1071): the latest final, GitHub's latest release, or with
 * release candidates on, the newest rc when it is newer. Only rc tags count from the feed, so a
 * final withdrawn by marking it a prerelease (v0.1.3) reaches no one. electron-updater's own
 * GitHub lookup keeps an app installed from an rc on rcs and never offers it a final, so the app
 * picks the release itself.
 */
export function pickRelease(latest: string | null, tags: string[], rcs: boolean): string | null {
  let best = latest && parts(latest) ? latest : null;
  if (!rcs) return best;
  for (const tag of tags) {
    const v = parts(tag);
    if (!v || v[3] === Infinity) continue;
    const b = best && parts(best);
    if (!b || newer(v, b)) best = tag;
  }
  return best;
}
