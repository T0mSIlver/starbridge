// The tip build (#1692): every push to main that touches the app builds it as
// `<version under way>-tip.<n>`, published as the one release `tip` of T0mSIlver/starbridge-tip,
// which Macs on the Tip channel read (spec/releases.md). Run by .github/workflows/desktop.yml:
//
//   bun desktop/scripts/tip.ts plan     before the build: build, version, last
//   bun desktop/scripts/tip.ts check    before publishing: publish, previous (the tip's version)
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TIP_REPO = "T0mSIlver/starbridge-tip";
const API = `https://api.github.com/repos/${TIP_REPO}/releases`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|tip)\.(\d+))?$/;

/** What the app is built from: desktop.yml's paths, whose commits number the tip builds. */
export const APP_PATHS = ["desktop", "pnpm-lock.yaml", ".github/workflows/desktop.yml"];

/**
 * The version a tip build takes. The version under way is the package's for an rc (0.1.7-rc.3 →
 * 0.1.7), and the next patch once that version's final is out or the package names a final, as
 * for Android's builds of main (VersionCode.kt). `-tip.n` sorts above the version's rcs, since
 * semver compares "tip" and "rc" as text, and below its final. `n` is how many commits on main
 * changed the app's paths: it grows with every build and reads no state, so a build never waits
 * for the last one to be published to know its number.
 */
export function tipVersion(pkg: string, finalOut: boolean, n: number): string {
  const m = VERSION.exec(pkg);
  if (!m || m[4] === "tip") throw new Error(`not a release version: ${pkg}`);
  const patch = Number(m[3]);
  return `${m[1]}.${m[2]}.${m[4] && !finalOut ? patch : patch + 1}-tip.${n}`;
}

type Tip = { version: string; commit: string };

/**
 * What the tip release holds, from its `tip.json`; null before its first build. Read through the
 * API with `GH_TOKEN`: the download URL answers from a cache that kept a 404 for minutes after
 * the file existed.
 */
export async function tipState(): Promise<Tip | null> {
  const headers: Record<string, string> = { "x-github-api-version": "2022-11-28" };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const release = await fetch(`${API}/tags/tip`, { headers });
  if (release.status === 404) return null;
  if (!release.ok) throw new Error(`the tip release answered ${release.status}`);
  const { assets } = (await release.json()) as { assets: { name: string; url: string }[] };
  const asset = assets.find((a) => a.name === "tip.json");
  if (!asset) return null;
  const res = await fetch(asset.url, {
    headers: { ...headers, accept: "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`the tip release's tip.json answered ${res.status}`);
  const s = (await res.json()) as { version?: unknown; commit?: unknown };
  if (
    typeof s.version !== "string" ||
    typeof s.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(s.commit)
  )
    throw new Error("the tip release's tip.json holds no version and commit");
  return { version: s.version, commit: s.commit };
}

const ROOT = join(import.meta.dirname, "..", "..");
const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "inherit" });

/**
 * Whether the tip already holds this commit or a newer one: a rebuild, or a run that waited
 * behind a newer one, which neither builds nor publishes.
 */
function held(sha: string, tip: Tip | null): boolean {
  if (!tip) return false;
  const holds =
    git("cat-file", "-e", `${tip.commit}^{commit}`).success &&
    git("merge-base", "--is-ancestor", sha, tip.commit).success;
  if (holds) {
    const msg = `The tip already holds ${tip.version} from ${tip.commit.slice(0, 8)}, which contains ${sha.slice(0, 8)}: nothing to do.`;
    console.log(msg);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${msg}\n`);
  }
  return holds;
}

/** `plan`: build, version and last (the tip's commit). `check`: publish. */
async function main(mode: string): Promise<void> {
  const sha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD").stdout.toString().trim();
  const out: Record<string, string> = {};
  if (mode === "check") {
    // Publishing over a newer build would take Macs back, so a failed read stops the publish.
    const tip = await tipState();
    out.publish = String(!held(sha, tip));
    out.previous = tip?.version ?? "";
  } else {
    // Here the read only spares a build the tip already holds: on failure, build.
    const tip = await tipState().catch((e) => {
      console.log(`::warning::Could not read the tip release, building anyway: ${e.message}`);
      return null;
    });
    out.last = tip?.commit ?? "";
    out.build = String(!held(sha, tip));
    if (out.build === "true") {
      const pkg = JSON.parse(readFileSync(join(ROOT, "desktop", "package.json"), "utf8")).version;
      const base = pkg.replace(/-.*/, "");
      const finalOut = git("rev-parse", "-q", "--verify", `refs/tags/v${base}`).success;
      const n = Number(git("rev-list", "--count", sha, "--", ...APP_PATHS).stdout.toString());
      out.version = tipVersion(pkg, finalOut, n);
      console.log(
        `Building ${out.version} from ${sha.slice(0, 8)} (tip: ${tip?.version ?? "none"}).`,
      );
    }
  }
  const lines = Object.entries(out)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
  else process.stdout.write(lines);
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "";
  if (mode !== "plan" && mode !== "check") {
    console.error("usage: bun desktop/scripts/tip.ts plan|check");
    process.exit(2);
  }
  await main(mode);
}
