import { createHash, createPublicKey, verify } from "node:crypto";
import { realpathSync } from "node:fs";
import { UsageError } from "./context";

/** The release key. Also in cli/minisign.pub, cli/install.sh and the README. */
export const RELEASE_KEY = "RWRT+qMmByDpj/1KhL5yCxdzIkVgZ3NqTrlVIIvhrezr/38FgzBIen0F";
export const RELEASES_URL = "https://github.com/T0mSIlver/starbridge/releases";

// Ed25519 SubjectPublicKeyInfo header; the 32-byte key follows.
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Checks a minisign signature (https://jedisct1.github.io/minisign/) and returns its trusted
 * comment: the key id, the Ed25519 signature over the file (over its BLAKE2b-512 hash for the
 * prehashed "ED" kind), then the one over the signature and the trusted comment.
 */
export function verifyMinisign(file: Uint8Array, minisig: string, pubkey = RELEASE_KEY): string {
  const bad = (why: string) => new UsageError(`release signature check failed: ${why}`);
  const pub = Buffer.from(pubkey, "base64");
  const lines = minisig.split("\n");
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  const comment = lines[2] ?? "";
  if (pub.length !== 42 || sig.length !== 74 || global.length !== 64) throw bad("malformed");
  if (!pub.subarray(2, 10).equals(sig.subarray(2, 10))) throw bad("signed by another key");
  if (!comment.startsWith("trusted comment: ")) throw bad("no trusted comment");
  const alg = sig.subarray(0, 2).toString("latin1");
  if (alg !== "ED" && alg !== "Ed") throw bad(`unknown algorithm ${alg}`);
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, pub.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const signed = alg === "ED" ? createHash("blake2b512").update(file).digest() : file;
  const s = sig.subarray(10);
  if (!verify(null, signed, key, s)) throw bad("the signature does not match");
  const text = comment.slice("trusted comment: ".length);
  if (!verify(null, Buffer.concat([s, Buffer.from(text)]), key, global))
    throw bad("the trusted comment does not match");
  return text;
}

/** `sha256sum` output: file name to hex hash. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2] as string, m[1] as string);
  }
  return sums;
}

/** The release asset for this machine, as `cli/scripts/build-bin.ts` names it. */
export function platformAsset(platform: string = process.platform, arch: string = process.arch) {
  const os = { linux: "linux", darwin: "darwin" }[platform];
  const cpu = { x64: "x64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new UsageError(`no starbridge build for ${platform}-${arch}`);
  return `starbridge-${os}-${cpu}`;
}

/** Orders `1.2.3` and `1.2.3-rc.4` versions; a release sorts after its release candidates. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v);
    if (!m) throw new UsageError(`not a version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++)
    if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  return 0;
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok && !(res.status >= 300 && res.status < 400))
    throw new UsageError(`download failed: ${res.status} ${url}`);
  return res;
}

/** The latest release's version, from where GitHub redirects `releases/latest`. */
export async function latestVersion(releases = RELEASES_URL): Promise<string> {
  const res = await get(`${releases}/latest`, { redirect: "manual" });
  const m = /\/tag\/v([^/]+)$/.exec(res.headers.get("location") ?? "");
  if (!m) throw new UsageError(`no latest release at ${releases}`);
  return m[1] as string;
}

/** Downloads one asset of a release and returns it only if the signed SHA256SUMS lists its hash. */
export async function downloadVerified(
  version: string,
  asset: string,
  opts: { releases?: string; pubkey?: string } = {},
): Promise<Uint8Array> {
  const base = `${opts.releases ?? RELEASES_URL}/download/v${version}`;
  const sums = new Uint8Array(await (await get(`${base}/SHA256SUMS`)).arrayBuffer());
  const minisig = await (await get(`${base}/SHA256SUMS.minisig`)).text();
  verifyMinisign(sums, minisig, opts.pubkey);
  const want = parseSums(new TextDecoder().decode(sums)).get(asset);
  if (!want) throw new UsageError(`SHA256SUMS lists no ${asset}`);
  const bytes = new Uint8Array(await (await get(`${base}/${asset}`)).arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== want)
    throw new UsageError(`${asset} does not match its hash in SHA256SUMS`);
  return bytes;
}

export type InstallKind = { kind: "binary"; path: string } | { kind: "brew" } | { kind: "npm" };

/**
 * How this copy was installed. The compiled binary runs from Bun's embedded file system; under a
 * Homebrew Cellar it belongs to brew. Anything else runs as a script under Node or Bun: npm.
 */
export function installKind(): InstallKind {
  const compiled = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
  if (!compiled) return { kind: "npm" };
  const path = realpathSync(process.execPath);
  return path.includes("/Cellar/") ? { kind: "brew" } : { kind: "binary", path };
}
