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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseUsage, runCodexbar } from "../codexbar";
import { lastLine, run, type Sys, which } from "./sys";

/**
 * The CodexBar CLI release setup installs, with the SHA-256 of each tarball, checked when it
 * downloads one. Hashes taken 2026-10-05 from the downloaded files, which match the `.sha256`
 * files of the release.
 */
export const CODEXBAR_RELEASE = {
  version: "0.72.0",
  sha256: {
    "linux-aarch64": "e0a305dae0e45ff947f49913b17beed137fe2faf7c81068b245c3689d9db7eb5",
    "linux-musl-aarch64": "e610b2896e031fe2632f20ed1ea5120d2201227a49da1dadabb9ab04d0c48e58",
    "linux-musl-x86_64": "b9ee23b79a7f44e9bb92c1268412fb0b41406a703867e43b1daabfdf299feb00",
    "linux-x86_64": "1772b5a2f4d68b959cd969a8997e4141474959f5cc89adff15b134d075b78b70",
    "macos-arm64": "64d627747ad8c58c40ea2d1f1c30eafd2bdbcc9d50b0a81cf77bb5e5c21bc449",
    "macos-x86_64": "97e432e1cf37d92b07d2e176a12032c100c54da36de97db9eada2865d0aae84b",
  } as Record<string, string>,
};
const RELEASES = "https://github.com/steipete/CodexBar/releases/download";
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

/**
 * Downloads the pinned tarball, checks its hash and unpacks it, with its bundle, to
 * `~/.local/opt/codexbar`. Returns the `codexbar` inside.
 */
export async function installTarball(
  sys: Sys,
  key: string,
  release = CODEXBAR_RELEASE,
): Promise<string> {
  const want = release.sha256[key];
  if (!want) throw new Error(`no CodexBar build for ${key}`);
  const base = sys.ctx.env.STARBRIDGE_CODEXBAR_RELEASES ?? RELEASES;
  const name = `CodexBarCLI-v${release.version}-${key}.tar.gz`;
  const res = await fetch(`${base}/v${release.version}/${name}`, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`downloading ${name}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new Error(`${name} has SHA-256 ${got}, expected ${want}: not installed`);
  const opt = join(sys.home, ".local/opt");
  const dest = join(opt, "codexbar");
  const fresh = join(opt, `.codexbar.${process.pid}`);
  const file = `${fresh}.tar.gz`;
  mkdirSync(fresh, { recursive: true });
  try {
    writeFileSync(file, bytes);
    const r = await run(sys, "tar", ["-xzf", file, "-C", fresh]);
    if (r?.code !== 0) throw new Error(`unpacking ${name}: ${lastLine(r)}`);
    rmSync(dest, { recursive: true, force: true });
    renameSync(fresh, dest);
  } finally {
    rmSync(file, { force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
  return join(dest, "codexbar");
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
  const key = tarballKey(sys);
  if (!key) throw new Error(`no CodexBar build for ${sys.platform} ${sys.arch}`);
  log(`Downloading CodexBar ${CODEXBAR_RELEASE.version} (${key})`);
  const path = await installTarball(sys, key);
  const link = linkIntoLocalBin(sys, path);
  log(
    `Installed CodexBar to ${join(sys.home, ".local/opt/codexbar")}${link ? `, linked as ${link}` : ""}.`,
  );
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
