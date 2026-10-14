import pkg from "../package.json" with { type: "json" };

/** Set from the release tag by the release workflow before it builds. */
export const VERSION = pkg.version;

/**
 * The release's commit, which the release workflow sets as `gitHead` before it builds: the signed
 * binary carries it, and setup installs the Claude Code plugins and the Pi package at it, so what
 * runs in the agents is the code the signature covers. Undefined in a build from source.
 */
export const COMMIT: string | undefined = (() => {
  const head = (pkg as { gitHead?: unknown }).gitHead;
  return typeof head === "string" && /^[0-9a-f]{40}$/.test(head) ? head : undefined;
})();
