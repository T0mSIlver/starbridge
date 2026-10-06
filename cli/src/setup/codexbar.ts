/**
 * Setup's CodexBar step: find the `codexbar` CLI or install it, list the providers it can read,
 * and probe which of them work on this machine.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseUsage, runCodexbar } from "../codexbar";
import { failure, run, type Sys, which } from "./sys";

/**
 * Only the source repository is pinned: setup and `starbridge update` install its latest release,
 * or the one named, checked against the `.sha256` that release publishes beside each tarball.
 */
const REPO = "steipete/CodexBar";
const API = `https://api.github.com/repos/${REPO}/releases`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download`;
const PROBE_TIMEOUT_MS = 20_000;

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

/** The version of CodexBar's latest release, from the GitHub API. */
export async function latestCodexbar(sys: Sys): Promise<string> {
  const api = sys.ctx.env.STARBRIDGE_CODEXBAR_API ?? API;
  const res = await fetch(`${api}/latest`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`finding CodexBar's latest release: ${res.status}`);
  const tag = ((await res.json()) as { tag_name?: unknown }).tag_name;
  return releaseVersion(typeof tag === "string" ? tag : "");
}

/** The version a tarball install says it is, from the `VERSION` file its tarball carries. */
export function installedVersion(sys: Sys): string | undefined {
  try {
    return readFileSync(join(optDir(sys), "VERSION"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Downloads `version`'s tarball and the `.sha256` beside it in the same release, checks one
 * against the other and unpacks the tarball, with its bundle, to `~/.local/opt/codexbar`.
 * Installs nothing when the checksum is missing or differs. Returns the `codexbar` inside.
 */
export async function installTarball(sys: Sys, key: string, version: string): Promise<string> {
  const base = sys.ctx.env.STARBRIDGE_CODEXBAR_RELEASES ?? DOWNLOADS;
  const name = `CodexBarCLI-v${version}-${key}.tar.gz`;
  const url = `${base}/v${version}/${name}`;
  const signal = AbortSignal.timeout(10 * 60_000);
  const sums = await fetch(`${url}.sha256`, { signal });
  if (!sums.ok) throw new Error(`no checksum for ${name} (${sums.status}): not installed`);
  const want = /^[0-9a-f]{64}\b/i.exec((await sums.text()).trim())?.[0].toLowerCase();
  if (!want) throw new Error(`${name}.sha256 holds no SHA-256: not installed`);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`downloading ${name}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`${name} has SHA-256 ${got}, expected ${want}: not installed`);
  const dest = optDir(sys);
  const opt = dirname(dest);
  const fresh = join(opt, `.codexbar.${process.pid}`);
  const file = `${fresh}.tar.gz`;
  mkdirSync(fresh, { recursive: true });
  try {
    writeFileSync(file, bytes);
    const r = await run(sys, "tar", ["-xzf", file, "-C", fresh]);
    if (r?.code !== 0) throw new Error(`unpacking ${name}: ${failure(r)}`);
    rmSync(dest, { recursive: true, force: true });
    renameSync(fresh, dest);
  } finally {
    rmSync(file, { force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
  return join(dest, "codexbar");
}

/** Installs `version`, else the latest release, from its tarball; logs what it did. */
export async function installRelease(sys: Sys, version?: string): Promise<string> {
  const key = tarballKey(sys);
  if (!key) throw new Error(`no CodexBar build for ${sys.platform} ${sys.arch}`);
  const v = version ? releaseVersion(version) : await latestCodexbar(sys);
  sys.ctx.out(`Downloading CodexBar ${v} (${key})`);
  const path = await installTarball(sys, key, v);
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
 * `starbridge update`'s CodexBar step: moves a tarball install to the latest release, or to
 * `version` when one is named. Any other CodexBar, from Homebrew or the macOS app, is left to
 * the way it was installed.
 */
export async function updateCodexbar(
  sys: Sys,
  configured: string | undefined,
  version?: string,
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
  try {
    const want = version ? releaseVersion(version) : await latestCodexbar(sys);
    const have = installedVersion(sys);
    if (have === want) {
      out(`CodexBar ${have} is ${version ? "installed" : "up to date"}.`);
      return 0;
    }
    await installRelease(sys, want);
    return 0;
  } catch (e) {
    out(`Could not update CodexBar: ${(e as Error).message}`);
    return 1;
  }
}
