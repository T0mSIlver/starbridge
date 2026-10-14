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
  /** Whether the paths differ, which is how internal.yml decides; a change and its revert count commits but build nothing. */
  androidChanged?: boolean;
  stagingSinceRc?: number;
  /** Commit of each release's tag, by version. */
  commits: Record<string, string>;
  /** Undefined when GitHub did not answer. */
  openRegressions?: number;
  iosMainOn: boolean;
};

const short = (s?: string) => (s ? s.slice(0, 8) : "unknown");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** "Wed 14 Oct, 05:00" in a zone, built from parts so every ICU build prints the same. */
const zone = (d: Date, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.weekday} ${p.day} ${p.month}`, time: `${p.hour}:${p.minute}` };
};
/** A time in Europe/Paris and UTC. */
export const both = (d: Date) => {
  const paris = zone(d, "Europe/Paris");
  return `${paris.day}, ${paris.time} Paris, ${zone(d, "UTC").time} UTC`;
};
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
      ? `Android nightly ${both(nn)}`
      : `Android nightly ${both(nn)}: ${(f.androidChanged ?? f.androidSince > 0) ? `builds, ${f.androidSince} commits since main-${short(f.nightly?.sha)}` : "skips, app unchanged"}`,
  );
  out.push(f.iosMainOn ? "iPhone main: with the nightly" : "iPhone main: off, awaiting Apple");
  out.push(`Next rc: ${f.stagingSinceRc ?? "unknown"} commits on staging`);
  const rc = newest(f.releases, "rc");
  const fin = newest(f.releases, "final");
  if (rc && (!fin || rc.version.split("-")[0] !== fin.version)) {
    const age = f.now.getTime() - Date.parse(rc.shipped);
    const day = age >= 86_400_000 ? "done" : `${hours(86_400_000 - age)} left`;
    out.push(
      `${rc.version} needs a day on testers (${day}), no open regression (${f.openRegressions ?? "unknown"} open), your yes`,
    );
  }
  out.push("Mac apps check every 6 h");
  return out;
}

export function newest(r: Releases, ring: "rc" | "final") {
  return r.releases
    .filter((e) => e.ring === ring)
    .sort((a, b) => b.shipped.localeCompare(a.shipped))[0];
}

const PRODUCTS = ["Server and web", "Android", "iPhone", "Mac app", "CLI", "Plugin"] as const;

function where(p: (typeof PRODUCTS)[number], e: Releases["releases"][number], f: Facts): string {
  const c = e.channels;
  const gh = "GitHub";
  const l: string[] = [];
  if (p === "Server and web") l.push("starbridge.run");
  if (p === "Android") {
    if (c.play) l.push(c.play.track === "alpha" ? "Play Alpha" : "Play");
    if (c.github) l.push(gh);
  }
  if (p === "iPhone" && c.testflight) l.push(`TestFlight ${c.testflight.build}`);
  if (p === "Mac app" && c.desktop) l.push(gh);
  if (p === "CLI") {
    if (c.npm) l.push(e.ring === "rc" ? "npm next" : "npm");
    if (c.homebrew) l.push("Homebrew");
    if (c.github) l.push(gh);
  }
  if (p === "Plugin") l.push(e.ring === "final" ? "Marketplace after its PR" : "Finals only");
  void f;
  return l.join(" · ") || "not published";
}

function main(f: Facts, p: (typeof PRODUCTS)[number]): string {
  const none = (t: string) => `<span class="ver none">${t}</span>`;
  switch (p) {
    case "Server and web":
      return `<span class="ver">${commit(f.staging)}</span><p class="where">Staging · prod ${commit(f.prod)}</p>`;
    case "Android":
      return f.nightly
        ? `<span class="ver">main-${short(f.nightly.sha)}</span><p class="meta">${commit(f.nightly.sha)} · ${both(new Date(f.nightly.at))}</p><p class="where">Play internal</p>`
        : none("None yet");
    case "iPhone":
      return none(f.iosMainOn ? "With the nightly" : "Off");
    default:
      return none("None");
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
      `<div class="prod"><p class="name">${p}</p><div class="rings"><div class="ring"><p class="label">Main</p>${main(f, p)}</div>${cell("rc", rc, p, f)}${cell("Final", fin, p, f)}</div></div>`,
  ).join("");
  const nextRows = next(f)
    .map((t) => `<li>${esc(t)}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Ops · Starbridge</title><link rel="icon" href="favicon.ico" sizes="48x48"><link rel="preload" href="fonts/google-sans-flex.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body><main>
<header><span class="brand">${MARK}Starbridge ops</span></header>
<div class="card intro"><h1>Rings</h1><p>Main: staging, your phone.<br>rc: testers, starbridge.run.<br>Final: everyone, after a day and your yes.</p><p><a href="https://github.com/${REPO}/blob/main/spec/releases.md">spec/releases.md</a> · <a href="${POLICY}">Policy</a></p></div>
<section><h2>Now</h2><div class="card prods">${rows}</div></section>
<section><h2>Next</h2><div class="card next"><ul>${nextRows}</ul></div></section>
<footer><p>As of ${both(f.now)}</p></footer></main></body></html>`;
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
  // The newest internal run whose play job built the app; unchanged nights skip it, so look through pages.
  let nightly: Facts["nightly"];
  for (let page = 1; page <= 10 && !nightly; page++) {
    const runs = await api<{
      workflow_runs: { id: number; head_sha: string; created_at: string }[];
    }>(`actions/workflows/internal.yml/runs?status=completed&per_page=30&page=${page}`);
    if (!runs?.workflow_runs.length) break;
    for (const r of runs.workflow_runs) {
      const jobs = await api<{ jobs: { name: string; conclusion: string }[] }>(
        `actions/runs/${r.id}/jobs`,
      );
      if (jobs?.jobs.some((j) => j.name === "play" && j.conclusion === "success")) {
        nightly = { sha: r.head_sha, at: r.created_at };
        break;
      }
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
    androidChanged: nightly
      ? spawnSync("git", [
          "diff",
          "--quiet",
          nightly.sha,
          "origin/main",
          "--",
          "android",
          "packages/protocol/vectors",
        ]).status !== 0
      : undefined,
    stagingSinceRc: rc && staging ? count(`v${rc.version}..${staging}`) : undefined,
    commits,
    openRegressions: issues ? issues.filter((i) => !i.pull_request).length : undefined,
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
