import pkg from "../package.json" with { type: "json" };

/** Set from the release tag by the release workflow before it builds. */
export const VERSION = pkg.version;
