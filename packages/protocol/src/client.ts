import { z } from "zod";

/**
 * Every request to the server names its client and release: `starbridge-client: cli/1.0.0`.
 * The server counts versions in use and answers a release below its minimum for that client
 * with 426 and `ClientTooOld`.
 */
export const CLIENT_HEADER = "starbridge-client";

export const CLIENT_NAMES = ["cli", "android", "web", "mod"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

/** MAJOR.MINOR.PATCH, with an optional pre-release (`-rc.2`). */
const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(-[0-9A-Za-z.-]{1,32})?$/;

export interface ClientVersion {
  name: ClientName;
  /** [major, minor, patch] */
  version: [number, number, number];
  /** A release candidate or other pre-release of `version`. */
  pre: boolean;
}

export function clientHeader(name: ClientName, version: string): string {
  return `${name}/${version}`;
}

/** The header's client and release, or null when it is missing or not one of ours. */
export function parseClientHeader(value: string | null | undefined): ClientVersion | null {
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash < 0) return null;
  const name = value.slice(0, slash) as ClientName;
  const m = VERSION.exec(value.slice(slash + 1));
  if (!CLIENT_NAMES.includes(name) || !m) return null;
  return { name, version: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
}

/** MAJOR.MINOR.PATCH without a pre-release: what a minimum must be. The server checks at start. */
export function isMinimumRelease(v: string): boolean {
  const m = VERSION.exec(v);
  return m !== null && m[4] === undefined;
}

/**
 * Whether the client's release comes before `minimum`, MAJOR.MINOR.PATCH without a pre-release.
 * A pre-release comes before its release: `1.2.0-rc.1` is below 1.2.0.
 */
export function versionBelow(
  client: Pick<ClientVersion, "version" | "pre">,
  minimum: string,
): boolean {
  const m = VERSION.exec(minimum);
  if (!m || !isMinimumRelease(minimum)) throw new Error(`not a minimum release: ${minimum}`);
  for (let i = 0; i < 3; i++) {
    const a = client.version[i] as number;
    const b = Number(m[i + 1]);
    if (a !== b) return a < b;
  }
  return client.pre;
}

/** The 426 body: the client named in the header, and the oldest release the server accepts. */
export const ClientTooOld = z.object({
  error: z.literal("client-too-old"),
  detail: z.string().optional(),
  client: z.enum(CLIENT_NAMES),
  minimum: z.string(),
});
export type ClientTooOld = z.infer<typeof ClientTooOld>;
