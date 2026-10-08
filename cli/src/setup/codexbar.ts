/**
 * Setup's CodexBar step: find the `codexbar` CLI or install it, list the providers it can read,
 * and probe which of them work on this machine.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseUsage, runCodexbar } from "../codexbar";
import type { Ctx } from "../context";
import PINNED from "./codexbar-pin.json" with { type: "json" };
import { failure, run, type Sys, which } from "./sys";

/**
 * A CodexBar release and its CLI tarballs' SHA-256, by `tarballKey`. Setup and `starbridge update`
 * install the one this binary carries, which the release's signature covers; a release named
 * with `update --codexbar <version>` is checked only against the `.sha256` beside its tarball.
 */
export interface Pin {
  version: string;
  sha256: Record<string, string>;
}
export const PIN: Pin = PINNED;

/** Every `tarballKey`: the pin holds a checksum for each. */
export const KEYS = [
  "macos-arm64",
  "macos-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "linux-musl-aarch64",
  "linux-musl-x86_64",
];

const RELEASES = "https://github.com/steipete/CodexBar/releases";
const PROBE_TIMEOUT_MS = 20_000;
/** How often a download says how far it got. */
const PROGRESS_MS = 5_000;

const APP_HELPERS = (home: string) => [
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
  join(home, "Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"),
];

export interface Found {
  path: string;
  /** Inside the macOS app, so not on the PATH by that name. */
  inApp?: boolean;
}

/** `codexbar` as configured, on the PATH, or inside the macOS app. */
export function findCodexbar(sys: Sys, configured?: string): Found | undefined {
  for (const p of [configured, sys.ctx.env.STARBRIDGE_CODEXBAR])
    if (p && existsSync(p)) return { path: p };
  const onPath = which(sys.ctx.env, "codexbar");
  if (onPath) return { path: onPath };
  const opt = join(sys.home, ".local/opt/codexbar/codexbar");
  if (existsSync(opt)) return { path: opt };
  if (sys.platform === "darwin")
    for (const p of APP_HELPERS(sys.home)) if (existsSync(p)) return { path: p, inApp: true };
  return undefined;
}

/** The release asset for this machine, as named in CodexBar's releases. */
export function tarballKey(sys: Sys, musl = isMusl()): string | undefined {
  const arch =
    sys.arch === "arm64"
      ? sys.platform === "darwin"
        ? "arm64"
        : "aarch64"
      : sys.arch === "x64"
        ? "x86_64"
        : undefined;
  if (!arch) return undefined;
  if (sys.platform === "darwin") return `macos-${arch}`;
  if (sys.platform === "linux") return musl ? `linux-musl-${arch}` : `linux-${arch}`;
  return undefined;
}

/**
 * The static musl build, where the glibc one would not start: on musl systems, and where
 * libcurl, which the glibc build links, is missing (a minimal Debian).
 */
function isMusl(): boolean {
  const has = (dir: string, prefix: string) => {
    try {
      return readdirSync(dir).some((f) => f.startsWith(prefix));
    } catch {
      return false;
    }
  };
  if (has("/lib", "ld-musl-")) return true;
  const libs = [
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
    "/usr/lib64",
    "/lib64",
    "/usr/lib",
  ];
  return !libs.some((d) => has(d, "libcurl.so.4"));
}

/** Links `~/.local/bin/codexbar` to `target`, unless something else already sits there. */
export function linkIntoLocalBin(sys: Sys, target: string): string | undefined {
  const bin = join(sys.home, ".local/bin");
  const link = join(bin, "codexbar");
  mkdirSync(bin, { recursive: true });
  try {
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    unlinkSync(link);
  } catch {}
  symlinkSync(target, link);
  return link;
}

/** Where a tarball install lives; `starbridge update` replaces only this one. */
export const optDir = (sys: Sys) => join(sys.home, ".local/opt/codexbar");

/** `0.72.0` from `v0.72.0` or `0.72.0`; throws on anything else, since it goes into a URL. */
export function releaseVersion(v: string): string {
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(v.trim());
  if (!m) throw new Error(`not a CodexBar version: ${v}`);
  return m[1] as string;
}

/**
 * Fetches a CodexBar release URL, with a sentence for what goes wrong: no network, or GitHub
 * limiting this address, which a campus or carrier NAT shares with many others (#618).
 */
async function fetchRelease(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`${what}: cannot reach ${new URL(url).host} (${(e as Error).message})`);
  }
  if (
    res.status === 429 ||
    (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
  )
    throw new Error(
      `${what}: GitHub is limiting requests from this address (${res.status}); try again in an hour`,
    );
  return res;
}

/**
 * The version of CodexBar's latest release, from where GitHub redirects `releases/latest`: the
 * API would allow only 60 unauthenticated requests an hour per address (#618).
 */
export async function latestCodexbar(env: Ctx["env"]): Promise<string> {
  const releases = env.STARBRIDGE_CODEXBAR_RELEASES ?? RELEASES;
  const what = "finding CodexBar's latest release";
  const res = await fetchRelease(
    `${releases}/latest`,
    { redirect: "manual", signal: AbortSignal.timeout(60_000) },
    what,
  );
  const tag = /\/tag\/([^/?#]+)$/.exec(res.headers.get("location") ?? "")?.[1];
  if (!tag) throw new Error(`${what}: ${res.status}, no release tag`);
  return releaseVersion(decodeURIComponent(tag));
}

/** Compares two CodexBar versions; a pre-release comes before its release. */
export function compareCodexbar(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = releaseVersion(v).split(/-(.*)/);
    return { nums: main.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++)
    if (x.nums[i] !== y.nums[i]) return (x.nums[i] as number) < (y.nums[i] as number) ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

const size = (bytes: number) =>
  bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;

/** The version a tarball install says it is, from the `VERSION` file its tarball carries. */
export function installedVersion(sys: Sys): string | undefined {
  try {
    return readFileSync(join(optDir(sys), "VERSION"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A release without this tarball's checksum. CodexBar marks a release latest some minutes before
 * its CLI tarballs and their checksums are uploaded.
 */
export class NoChecksum extends Error {}

/**
 * Downloads `version`'s tarball, checks it against `sha256` when given, else against the
 * `.sha256` beside it in the same release, and unpacks it, with its bundle, to
 * `~/.local/opt/codexbar`. Installs nothing when the checksum is missing or differs. Returns the
 * `codexbar` inside.
 */
export async function installTarball(
  sys: Sys,
  key: string,
  version: string,
  sha256?: string,
): Promise<string> {
  const base = `${sys.ctx.env.STARBRIDGE_CODEXBAR_RELEASES ?? RELEASES}/download`;
  const name = `CodexBarCLI-v${version}-${key}.tar.gz`;
  const url = `${base}/v${version}/${name}`;
  const signal = AbortSignal.timeout(10 * 60_000);
  let want = sha256;
  if (!want) {
    const sums = await fetchRelease(`${url}.sha256`, { signal }, `downloading ${name}.sha256`);
    if (!sums.ok) throw new NoChecksum(`no checksum for ${name} (${sums.status}): not installed`);
    want = /^[0-9a-f]{64}\b/i.exec((await sums.text()).trim())?.[0].toLowerCase();
    if (!want) throw new Error(`${name}.sha256 holds no SHA-256: not installed`);
  }
  const res = await fetchRelease(url, { signal }, `downloading ${name}`);
  if (!res.ok || !res.body) throw new Error(`downloading ${name}: ${res.status}`);
  const dest = optDir(sys);
  const opt = dirname(dest);
  const fresh = join(opt, `.codexbar.${process.pid}`);
  const file = `${fresh}.tar.gz`;
  const old = `${fresh}.old`;
  mkdirSync(fresh, { recursive: true });
  try {
    await download(sys, res, file, want, name, `CodexBar ${version} (${key})`);
    const r = await run(sys, "tar", ["-xzf", file, "-C", fresh]);
    if (r?.code !== 0)
      throw new Error(`could not unpack ${name} into ${opt}; is the disk full? (${failure(r)})`);
    // Renames rather than deletes first, so `codexbar` is missing only between two renames.
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(fresh, dest);
  } finally {
    rmSync(file, { force: true });
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  return join(dest, "codexbar");
}

/**
 * Streams `res`, the tarball `name` of `label`, into `file`, saying its size first and then how far it got every few seconds,
 * since a tarball of 170 MB takes a minute or more (#618). Throws unless its SHA-256 is `want`.
 */
async function download(
  sys: Sys,
  res: Response,
  file: string,
  want: string,
  name: string,
  label: string,
) {
  const total = Number(res.headers.get("content-length")) || undefined;
  sys.ctx.out(`Downloading ${label}${total ? `, ${size(total)}` : ""}`);
  const hash = createHash("sha256");
  const fd = openSync(file, "w");
  let got = 0;
  let said = sys.ctx.now().getTime();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      writeSync(fd, chunk);
      hash.update(chunk);
      got += chunk.length;
      const now = sys.ctx.now().getTime();
      if (now - said >= PROGRESS_MS) {
        said = now;
        sys.ctx.out(`  ${size(got)}${total ? ` of ${size(total)}` : ""}`);
      }
    }
  } catch (e) {
    throw new Error(`downloading ${name}: ${(e as Error).message}`);
  } finally {
    closeSync(fd);
  }
  const sha = hash.digest("hex");
  if (sha !== want) throw new Error(`${name} has SHA-256 ${sha}, expected ${want}: not installed`);
}

/**
 * Installs `version`, else the pinned one, from its tarball; logs what it did. The pinned version
 * is checked against the pin's checksum, any other against its release's `.sha256`.
 */
export async function installRelease(sys: Sys, version?: string, pin = PIN): Promise<string> {
  const key = tarballKey(sys);
  if (!key) throw new Error(`no CodexBar build for ${sys.platform} ${sys.arch}`);
  const v = version ? releaseVersion(version) : pin.version;
  const sha = v === pin.version ? pin.sha256[key] : undefined;
  if (v === pin.version && !sha) throw new Error(`no checksum pinned for CodexBar ${v} (${key})`);
  const path = await installTarball(sys, key, v, sha);
  const link = linkIntoLocalBin(sys, path);
  sys.ctx.out(`Installed CodexBar ${v} to ${optDir(sys)}${link ? `, linked as ${link}` : ""}.`);
  return path;
}

/**
 * Installs CodexBar the way this machine prefers: Homebrew when it exists (on macOS the app,
 * which adds browser cookie import), else the release tarball. Returns the CLI's path.
 */
export async function installCodexbar(sys: Sys): Promise<Found> {
  const log = sys.ctx.out;
  if (which(sys.ctx.env, "brew")) {
    const args =
      sys.platform === "darwin"
        ? ["install", "--cask", "codexbar"]
        : ["install", "steipete/tap/codexbar"];
    log(`Running brew ${args.join(" ")}`);
    const r = await run(sys, "brew", args, { timeoutMs: 15 * 60_000, inherit: true });
    if (r?.code !== 0) throw new Error(`brew ${args.join(" ")} failed`);
    const found = findCodexbar(sys);
    if (!found) throw new Error("brew installed CodexBar but its CLI is nowhere to be found");
    return found;
  }
  const path = await installRelease(sys);
  return { path };
}

export interface ProviderInfo {
  provider: string;
  displayName: string;
  enabled: boolean;
}

/** `codexbar config providers --format json`; empty when this CodexBar cannot list them. */
export async function listProviders(sys: Sys, bin: string): Promise<ProviderInfo[]> {
  const r = await run(sys, bin, ["config", "providers", "--format", "json"], { timeoutMs: 30_000 });
  if (r?.code !== 0) return [];
  try {
    const rows = JSON.parse(r.stdout) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((x) => {
      const o = x as Record<string, unknown>;
      if (typeof o.provider !== "string") return [];
      return [
        {
          provider: o.provider,
          displayName: typeof o.displayName === "string" ? o.displayName : o.provider,
          enabled: o.enabled === true,
        },
      ];
    });
  } catch {
    return [];
  }
}

export interface Probe {
  provider: string;
  displayName: string;
  works: boolean;
  /** Why not, in CodexBar's words; or how many windows it read. */
  detail: string;
}

/** Which providers to probe: the enabled ones, those named, and Claude and Codex when signed in. */
export function probeSet(sys: Sys, list: ProviderInfo[], named: string[]): string[] {
  const set = new Set([...list.filter((p) => p.enabled).map((p) => p.provider), ...named]);
  const claude =
    existsSync(join(sys.home, ".claude/.credentials.json")) || which(sys.ctx.env, "claude");
  if (claude) set.add("claude");
  if (existsSync(join(sys.home, ".codex/auth.json"))) set.add("codex");
  return [...set];
}

const failed = (r: { code: number | null; stderr: string }) =>
  r.stderr.trim().split("\n").pop() || `exited ${r.code}`;

/** Runs `usage --provider X` for each, in parallel. */
export async function probe(
  bin: string,
  providers: string[],
  list: ProviderInfo[],
): Promise<Probe[]> {
  const names = new Map(list.map((p) => [p.provider, p.displayName]));
  return Promise.all(
    providers.map(async (provider): Promise<Probe> => {
      const displayName = names.get(provider) ?? provider;
      const r = await runCodexbar(bin, provider, PROBE_TIMEOUT_MS);
      const no = (detail: string) => ({ provider, displayName, works: false, detail });
      if (r.code === null) return no("no answer within 20 s");
      try {
        const [row] = parseUsage(r.stdout, provider, new Date());
        if (!row) return no(r.code === 0 ? "not in CodexBar's output" : failed(r));
        if (row.error) return no(row.error);
        if (row.windows.length === 0) return no("no quota windows");
        const n = row.windows.length;
        return { provider, displayName, works: true, detail: `${n} window${n === 1 ? "" : "s"}` };
      } catch (e) {
        if (r.code === 0) return no(`unreadable output: ${(e as Error).message}`);
        return no(failed(r));
      }
    }),
  );
}

/**
 * `starbridge update`'s CodexBar step: moves a tarball install to the pinned release, or to
 * `version` when one is named. A newer one, which only `--codexbar` installs, is kept. Any other
 * CodexBar, from Homebrew or the macOS app, is left to the way it was installed.
 */
export async function updateCodexbar(
  sys: Sys,
  configured: string | undefined,
  version?: string,
  pin = PIN,
): Promise<number> {
  const out = sys.ctx.out;
  const found = findCodexbar(sys, configured);
  if (!found) {
    if (version) out("CodexBar is not installed: `starbridge setup` installs it.");
    return version ? 1 : 0;
  }
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  if (!real(found.path).startsWith(`${real(optDir(sys))}/`)) {
    out(
      `CodexBar at ${found.path} was not installed by starbridge: left alone (if Homebrew installed it, run brew upgrade codexbar).`,
    );
    return version ? 1 : 0;
  }
  const have = installedVersion(sys);
  try {
    const want = version ? releaseVersion(version) : pin.version;
    if (have === want) {
      out(`CodexBar ${have} is ${version ? "installed" : "up to date"}.`);
      return 0;
    }
    if (!version && have && compareCodexbar(have, want) > 0) {
      out(`CodexBar ${have} is newer than the ${want} this release installs: kept.`);
      return 0;
    }
    await installRelease(sys, want, pin);
    return 0;
  } catch (e) {
    out(`Could not update CodexBar: ${(e as Error).message}`);
    return 1;
  }
}
