import { z } from "zod";
import { isMinimumRelease, parseClientHeader } from "./client";

/** MAJOR.MINOR.PATCH, with an optional pre-release, as `starbridge-client` carries it. */
const Version = z.string().refine((v) => parseClientHeader(`cli/${v}`) !== null, "not a version");

/**
 * `PUT /release` (#1050): the CLI release a machine runs, and the latest release its local agent
 * last read from GitHub, null while it has not read one or its owner turned the check off. The
 * machine sends it when its agent starts and when either changes, so every device's Devices list
 * can say which machines are behind. Only the machine itself sets it.
 */
export const MachineRelease = z.object({
  version: Version,
  latest: Version.refine(isMinimumRelease, "a release, not a pre-release").nullable(),
});
export type MachineRelease = z.infer<typeof MachineRelease>;

/**
 * `GET /releases`: each active machine that has said, by member id. `behind` is the server's
 * comparison, `version` below `latest`, so clients compare nothing; false while `latest` is null.
 * `updatedAt` is when the machine last said a `version` other than the one before (#1266), so
 * devices can say when it moved to `version`; null until it has.
 */
export const MachineReleases = z.object({
  machines: z.record(
    z.string(),
    MachineRelease.extend({ behind: z.boolean(), updatedAt: z.string().nullable() }),
  ),
});
export type MachineReleases = z.infer<typeof MachineReleases>;
