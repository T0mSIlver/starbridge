/**
 * The owner's private ops page (#1630), the rings including main and what happens next:
 *   GH_TOKEN=… bun cli/scripts/ops-page.ts <out dir>
 * ops.yml builds it every 30 minutes and after a deploy or release, and uploads it to the Cloudflare Pages
 * project `starbridge-ops`, which Cloudflare Access closes to the owner. Run in a full clone of the repository.
 * It may show commits, since only the owner reads it; the public page (#1618) never does.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Releases } from "./releases";

const REPO = "T0mSIlver/starbridge";
const POLICY = "https://claude.ai/artifact/8HEhZtHRWRS5nECZB51MNk";

export type Facts = {
  now: Date;
  releases: Releases;
  /** The commits starbridge.run and staging report in x-starbridge-revision. */
  prod?: string;
  staging?: string;
  /** The last internal run that built the Android app: its commit and time. */
  nightly?: { sha: string; at: string };
  /** Commits that touch the Android app since the nightly's, and staging's not yet in the newest rc. */
  androidSince?: number;
  stagingSinceRc?: number;
  /** Commit of each release's tag, by version. */
  commits: Record<string, string>;
  openRegressions: number;
  iosMainOn: boolean;
};

const short = (s?: string) => (s ? s.slice(0, 8) : "unknown");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const zone = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
/** A time in Europe/Paris and UTC. */
export const both = (d: Date) =>
  `${zone(d, "Europe/Paris")} Paris, ${zone(d, "UTC").split(", ")[1]} UTC`;
const commit = (sha?: string) =>
  sha
    ? `<a href="https://github.com/${REPO}/commit/${esc(sha)}"><code>${short(sha)}</code></a>`
    : "unknown";

/** The next 03:00 UTC after `now`. */
export function nextNightly(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3));
  return d > now ? d : new Date(d.getTime() + 86_400_000);
}

const hours = (ms: number) => {
  const h = Math.floor(ms / 3_600_000);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} days`;
};

export function next(f: Facts): string[] {
  const out: string[] = [];
  const nn = nextNightly(f.now);
  out.push(
    f.androidSince === undefined
      ? `Android nightly builds at ${both(nn)}.`
      : `Android nightly builds at ${both(nn)}: ${f.androidSince > 0 ? `will build (${f.androidSince} android/ commits since main-${short(f.nightly?.sha)})` : "will skip (no android/ change)"}.`,
  );
  out.push(
    f.iosMainOn
      ? "iPhone main builds go to TestFlight with the nightly."
      : "iPhone main builds are off until Apple's export compliance code arrives.",
  );
  out.push(
    `Next rc: cut by the orchestrator when a batch lands; ${f.stagingSinceRc ?? "an unknown number of"} commits on staging are not yet in an rc.`,
  );
  const rc = newest(f.releases, "rc");
  const fin = newest(f.releases, "final");
  if (rc && (!fin || rc.version.split("-")[0] !== fin.version)) {
    const age = f.now.getTime() - Date.parse(rc.shipped);
    const day = age >= 86_400_000 ? "done" : `${hours(86_400_000 - age)} left`;
    out.push(
      `${rc.version} has been on testers for ${hours(age)}. Promotion needs a day on the rc (${day}), no open regression issue (${f.openRegressions} open) and your yes.`,
    );
  }
  out.push("Mac apps check for updates every 6 hours.");
  out.push("Play Alpha waits on Play's review after an upload.");
  return out;
}

export function newest(r: Releases, ring: "rc" | "final") {
  return r.releases
    .filter((e) => e.ring === ring)
    .sort((a, b) => b.shipped.localeCompare(a.shipped))[0];
}

const PRODUCTS = [
  "Hosted server and web page",
  "Android",
  "iPhone",
  "Mac app",
  "CLI",
  "Claude Code plugin",
] as const;

function where(p: (typeof PRODUCTS)[number], e: Releases["releases"][number], f: Facts): string {
  const c = e.channels;
  const gh = e.ring === "rc" ? "GitHub prerelease" : "GitHub latest";
  const l: string[] = [];
  if (p === "Hosted server and web page") l.push("starbridge.run");
  if (p === "Android") {
    if (c.play) l.push(c.play.track === "alpha" ? "Play Alpha" : "Play production");
    if (c.github) l.push(gh);
  }
  if (p === "iPhone" && c.testflight) l.push(`TestFlight build ${c.testflight.build}`);
  if (p === "Mac app" && c.desktop) l.push(gh);
  if (p === "CLI") {
    if (c.npm) l.push(e.ring === "rc" ? "npm next" : "npm latest");
    if (c.homebrew) l.push("Homebrew");
    if (c.github) l.push(gh);
  }
  if (p === "Claude Code plugin")
    l.push(e.ring === "final" ? "marketplace once its pull request merges" : "ships with finals");
  void f;
  return l.join(" · ") || "not published";
}

function main(f: Facts, p: (typeof PRODUCTS)[number]): string {
  const none = (t: string) => `<span class="ver none">${t}</span>`;
  switch (p) {
    case "Hosted server and web page":
      return `<span class="ver">staging ${commit(f.staging)}</span><p class="meta">starbridge.run runs ${commit(f.prod)}</p>`;
    case "Android":
      return f.nightly
        ? `<span class="ver">main-${short(f.nightly.sha)}</span><p class="meta">${commit(f.nightly.sha)} · ${both(new Date(f.nightly.at))}</p><p class="where">Play internal track</p>`
        : none("No nightly yet");
    case "iPhone":
      return none(f.iosMainOn ? "With the nightly" : "Off");
    default:
      return none("No main build");
  }
}

function cell(
  label: string,
  e: Releases["releases"][number] | undefined,
  p: (typeof PRODUCTS)[number],
  f: Facts,
) {
  if (!e)
    return `<div class="ring"><p class="label">${label}</p><span class="ver none">None yet</span></div>`;
  return `<div class="ring"><p class="label">${label}</p><a class="ver" href="https://github.com/${REPO}/releases/tag/v${e.version}">${e.version}</a><p class="meta">${commit(f.commits[e.version])} · ${both(new Date(e.shipped))}</p><p class="where">${esc(where(p, e, f))}</p></div>`;
}

export function render(f: Facts): string {
  const rc = newest(f.releases, "rc");
  const fin = newest(f.releases, "final");
  const rows = PRODUCTS.map(
    (p) =>
      `<div class="prod"><p class="name">${p}</p><div class="rings"><div class="ring"><p class="label">Main</p>${main(f, p)}</div>${cell("Release candidate", rc, p, f)}${cell("Final", fin, p, f)}</div></div>`,
  ).join("");
  const nextRows = next(f)
    .map((t) => `<li>${esc(t)}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Ops · Starbridge</title><link rel="icon" href="favicon.ico" sizes="48x48"><link rel="preload" href="fonts/google-sans-flex.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body><main>
<header><span class="brand">${MARK}Starbridge ops</span></header>
<div class="card intro"><h1>How the rings work</h1><p>Every merge to main goes to staging. A release candidate (rc) is cut from main about daily, goes to testers on Play Alpha, TestFlight, npm next and the Mac apps that follow rcs, and deploys to starbridge.run. A final is its newest rc plus the version stamp, promoted after a day with no open regression and your yes: it reaches everyone. The Android nightly is main on Play's internal track. <a href="https://github.com/${REPO}/blob/main/spec/releases.md">spec/releases.md</a> · <a href="${POLICY}">The policy</a></p></div>
<section><h2>Each ring now</h2><div class="card prods">${rows}</div></section>
<section><h2>What happens next</h2><div class="card next"><ul>${nextRows}</ul></div></section>
<footer><p>As of ${both(f.now)}, to the hour. Private: Cloudflare Access lets in the owner only.</p></footer></main></body></html>`;
}

const MARK = `<svg class="mark" width="20" height="20" viewBox="29.25 24.75 49.5 49.5" aria-hidden="true"><path class="fg" d="M29.25,72.75 V58.5 A24.75,24.75 0 0 1 78.75,58.5 V72.75 A1.5,1.5 0 0 1 77.25,74.25 H71.25 A1.5,1.5 0 0 1 69.75,72.75 V58.5 A9.25,9.25 0 0 0 51.25,58.5 V72.75 A1.5,1.5 0 0 1 49.75,74.25 H30.75 A1.5,1.5 0 0 1 29.25,72.75 Z"/><circle class="dot" cx="60.5" cy="68.75" r="5.5"/></svg>`;

// DESIGN.md's tokens as the status page's Ledger look uses them, light then dark.
const CSS = `@font-face{font-family:"Google Sans Flex";src:url(fonts/google-sans-flex.woff2) format("woff2");font-weight:1 1000;font-display:swap}
:root{--bg:#f4f4f4;--surface:#fff;--surface2:#ebebeb;--line:#e0e0e0;--fg:#121212;--fg2:#595959;--fg3:#8c8c8c;--accent:#965700;--sans:"Google Sans Flex","Roboto Flex",system-ui,-apple-system,sans-serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0c;--surface:#171717;--surface2:#232323;--line:#2a2a2a;--fg:#f1f1f1;--fg2:#a3a3a3;--fg3:#6a6a6a;--accent:#f5a83b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 16px/24px var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit;text-underline-offset:3px;text-decoration-color:var(--fg3)}
code{font:inherit;font-variant-numeric:tabular-nums}
.mark{width:20px;height:20px;flex:none}.mark .fg{fill:var(--fg)}.mark .dot{fill:var(--accent)}
header{display:flex;align-items:center;gap:12px}.brand{display:flex;align-items:baseline;gap:8px;font:500 16px/24px var(--sans)}
.card{background:var(--surface);border-radius:16px}
.label{font:500 14px/20px var(--sans);color:var(--fg2);margin:0}
.meta{font:400 13px/20px var(--sans);color:var(--fg2);font-variant-numeric:tabular-nums}
main{max-width:960px;margin:0 auto;padding:40px 24px 64px}
.intro{padding:24px;margin:32px 0 40px}.intro h1{font:500 24px/32px var(--sans);margin:0}.intro p{margin:8px 0 0;color:var(--fg2)}
h2{font:500 14px/20px var(--sans);color:var(--fg2);margin:0 0 12px}
section{margin:0 0 40px}
.prods{padding:4px 24px}.prod{padding:20px 0;border-top:1px solid var(--line)}.prod:first-child{border-top:0}
.prod .name{font:500 16px/24px var(--sans);margin:0 0 12px}
.rings{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.ring .label{margin:0 0 2px}.ring p{margin:2px 0 0}
.ver{display:block;font:500 18px/24px var(--sans);font-variant-numeric:tabular-nums}.ver.none{color:var(--fg3);font-weight:400}
.where{font:400 14px/20px var(--sans)}
.next{padding:16px 24px}.next ul{margin:0;padding-left:20px}.next li{padding:4px 0}
footer{color:var(--fg2);font:400 13px/20px var(--sans)}
@media (max-width:700px){main{padding:24px 16px 48px}.intro{padding:20px;margin:24px 0 32px}.prods,.next{padding-left:16px;padding-right:16px}.rings{grid-template-columns:1fr;gap:12px}}`;

function sh(cmd: string, ...args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

async function api<T>(
  path: string,
  accept = "application/vnd.github+json",
): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept },
  }).catch(() => undefined);
  return res?.ok ? ((await res.json()) as T) : undefined;
}

async function revision(host: string): Promise<string | undefined> {
  const res = await fetch(`https://${host}/healthz`).catch(() => undefined);
  const r = res?.headers.get("x-starbridge-revision") ?? "";
  return /^[0-9a-f]{40}$/.test(r) ? r : undefined;
}

const count = (range: string, ...paths: string[]) => {
  const n = sh("git", "rev-list", "--count", range, ...(paths.length ? ["--", ...paths] : []));
  return n === "" ? undefined : Number(n);
};

export async function gather(): Promise<Facts> {
  const releases = (await api<{ content: string }>("contents/releases.json?ref=releases-data"))
    ?.content;
  const data: Releases = releases
    ? JSON.parse(Buffer.from(releases, "base64").toString())
    : { schema: 1, updated: "", releases: [] };
  const [prod, staging] = await Promise.all([
    revision("starbridge.run"),
    revision("staging.starbridge.run"),
  ]);
  // The newest internal run whose play job built the app.
  let nightly: Facts["nightly"];
  const runs = await api<{ workflow_runs: { id: number; head_sha: string; created_at: string }[] }>(
    "actions/workflows/internal.yml/runs?status=completed&per_page=15",
  );
  for (const r of runs?.workflow_runs ?? []) {
    const jobs = await api<{ jobs: { name: string; conclusion: string }[] }>(
      `actions/runs/${r.id}/jobs`,
    );
    if (jobs?.jobs.some((j) => j.name === "play" && j.conclusion === "success")) {
      nightly = { sha: r.head_sha, at: r.created_at };
      break;
    }
  }
  const commits: Record<string, string> = {};
  for (const e of data.releases) commits[e.version] = sh("git", "rev-list", "-n1", `v${e.version}`);
  const rc = newest(data, "rc");
  const issues = await api<{ pull_request?: unknown }[]>(
    "issues?labels=regression&state=open&per_page=100",
  );
  return {
    now: new Date(),
    releases: data,
    prod,
    staging,
    nightly,
    androidSince: nightly
      ? count(`${nightly.sha}..origin/main`, "android", "packages/protocol/vectors")
      : undefined,
    stagingSinceRc: rc && staging ? count(`v${rc.version}..${staging}`) : undefined,
    commits,
    openRegressions: (issues ?? []).filter((i) => !i.pull_request).length,
    iosMainOn: process.env.IOS_MAIN_TESTFLIGHT === "true",
  };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: GH_TOKEN=… ops-page.ts <out dir>");
  const f = await gather();
  // Rounded to the hour, so a rebuild with nothing new uploads nothing.
  f.now = new Date(Math.floor(f.now.getTime() / 3_600_000) * 3_600_000);
  mkdirSync(join(out, "fonts"), { recursive: true });
  writeFileSync(join(out, "index.html"), render(f));
  copyFileSync(
    "web/src/fonts/google-sans-flex-latin-wght-normal.woff2",
    join(out, "fonts/google-sans-flex.woff2"),
  );
  copyFileSync("web/src/app/favicon.ico", join(out, "favicon.ico"));
}
