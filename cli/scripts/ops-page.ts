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
import { LABEL_PREFIX } from "./found-in";
import type { Releases } from "./releases";

const REPO = "T0mSIlver/starbridge";
const POLICY = "https://claude.ai/artifact/8HEhZtHRWRS5nECZB51MNk";

/** A bug and the release it was found in (found-in.yml's label, #1890). */
export type Bug = {
  number: number;
  title: string;
  open: boolean;
  /** The version in its `found-in:` label, or "unknown". */
  foundIn: string;
  regression: boolean;
  /** For a closed bug: the first tag that holds the commit that closed it, if any. */
  fixedIn?: string;
  /** Closed, but not by a commit on main (a duplicate, won't fix, or closed by hand). */
  closedByHand?: boolean;
};

export type Facts = {
  now: Date;
  releases: Releases;
  /** The commits starbridge.run and staging report in x-starbridge-revision. */
  prod?: string;
  staging?: string;
  /** The last internal run that built the Android app: its commit and time. */
  internalBuild?: { sha: string; at: string };
  /** The Mac app's newest tip build (T0mSIlver/starbridge-tip): version, commit and publish time. */
  tipBuild?: { version: string; sha: string; at: string };
  /** Commits that touch the Mac app since that build, and whether its paths differ (as androidChanged). */
  macSince?: number;
  macChanged?: boolean;
  /** Commits that touch the Android app since that build, and staging's not yet in the newest rc. */
  androidSince?: number;
  /** Whether the paths differ, which is how a build differs from the track's; a change and its revert count commits but build nothing. */
  androidChanged?: boolean;
  stagingSinceRc?: number;
  /** Commit of each release's tag, by version. */
  commits: Record<string, string>;
  /** Undefined when GitHub did not answer. */
  openRegressions?: number;
  /** Open `regression` issues, and every issue with a `found-in:` label. Undefined when GitHub did not answer. */
  regressions?: Bug[];
  bugs?: Bug[];
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
      ? "Android main: builds on each merge that touches the app and each rc tag"
      : `Android main: builds on each merge that touches the app and each rc tag; ${(f.androidChanged ?? f.androidSince > 0) ? `${f.androidSince} commits not built since main-${short(f.internalBuild?.sha)}` : "none waiting"}`,
  );
  out.push(f.iosMainOn ? `iPhone main: nightly, ${both(nn)}` : "iPhone main: off, awaiting Apple");
  out.push(`Next rc: ${f.stagingSinceRc ?? "unknown"} commits on staging`);
  out.push(
    f.macSince === undefined
      ? "Mac main: builds on each merge that touches the app"
      : `Mac main: builds on each merge that touches the app; ${(f.macChanged ?? f.macSince > 0) ? `${f.macSince} commits not built since ${f.tipBuild?.version ?? "unknown"}` : "none waiting"}`,
  );
  out.push("Mac apps check every 6 h");
  out.push("Play Alpha: after Play's review");
  return out;
}

export function newest(r: Releases, ring: "rc" | "final") {
  return r.releases
    .filter((e) => e.ring === ring)
    .sort((a, b) => b.shipped.localeCompare(a.shipped))[0];
}

/** A promotion card goes out this long after an rc is cut (spec/releases.md, "Cadence"). */
const CLOCK_MS = 4 * 3_600_000;

export type Promotion = {
  final?: string;
  /** The newest rc, unless its version is already out as a final. */
  candidate?: { version: string; shipped: Date };
  /** The final it would become, and the rc that new work then goes to. */
  becomes?: string;
  nextRc?: string;
  /** The newest rc's time plus 4 hours: a newer rc moves it. */
  earliest?: Date;
  clockLeftMs?: number;
  /** The card is open, so no rc is cut except a fix to this one. */
  holdsNewRc?: boolean;
  regressions?: number;
  verdict: string;
};

export function promotion(f: Facts): Promotion {
  const rc = newest(f.releases, "rc");
  const fin = newest(f.releases, "final");
  const base = rc?.version.split("-")[0];
  if (!rc || !base || base === fin?.version)
    return { final: fin?.version, regressions: f.openRegressions, verdict: "Nothing to promote" };
  const shipped = new Date(rc.shipped);
  const earliest = new Date(shipped.getTime() + CLOCK_MS);
  const clockLeftMs = Math.max(0, earliest.getTime() - f.now.getTime());
  const [a, b, c] = base.split(".").map(Number) as [number, number, number];
  const reg = f.openRegressions;
  const verdict = reg
    ? `Blocked: ${reg} open regression${reg === 1 ? "" : "s"}`
    : clockLeftMs > 0
      ? `Waiting: ${hours(clockLeftMs)} left on the clock`
      : reg === undefined
        ? "Regressions unknown: check before you say yes"
        : "Ready for your yes";
  return {
    final: fin?.version,
    candidate: { version: rc.version, shipped },
    becomes: base,
    nextRc: `${a}.${b}.${c + 1}-rc.1`,
    earliest,
    clockLeftMs,
    holdsNewRc: !reg && clockLeftMs === 0 && reg !== undefined,
    regressions: reg,
    verdict,
  };
}

const PRODUCTS = ["Server and web", "Android", "iPhone", "Mac app", "CLI", "Plugin"] as const;

function where(p: (typeof PRODUCTS)[number], e: Releases["releases"][number], f: Facts): string {
  const c = e.channels;
  const gh = e.ring === "rc" ? "GitHub rc" : "GitHub latest";
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
  if (p === "Plugin")
    l.push(
      e.ring === "final"
        ? "Marketplace, once the PR pointing it at this tag merges"
        : "Not published: the plugin ships with finals",
    );
  void f;
  return l.join(" · ") || "not published";
}

function main(f: Facts, p: (typeof PRODUCTS)[number]): string {
  const none = (t: string) => `<span class="ver none">${t}</span>`;
  switch (p) {
    case "Server and web":
      return `<span class="ver">${commit(f.staging)}</span><p class="where">staging.starbridge.run · prod ${commit(f.prod)}</p>`;
    case "Android":
      return f.internalBuild
        ? `<span class="ver">main-${short(f.internalBuild.sha)}</span><p class="meta">${commit(f.internalBuild.sha)} · ${both(new Date(f.internalBuild.at))}</p><p class="where">Play internal</p>`
        : none("None yet");
    case "Mac app":
      return f.tipBuild
        ? `<span class="ver">${esc(f.tipBuild.version)}</span><p class="meta">${commit(f.tipBuild.sha)} · ${both(new Date(f.tipBuild.at))}</p><p class="where">Tip channel</p>`
        : none("None yet");
    case "iPhone":
      return none(f.iosMainOn ? "Nightly" : "Off");
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

function promotionHtml(f: Facts): string {
  const p = promotion(f);
  const lines = [`Final: ${p.final ?? "none yet"} (everyone).`];
  if (!p.candidate || !p.earliest || p.clockLeftMs === undefined || !p.becomes) {
    lines.push("Candidate: none. The newest rc is already out as a final.");
    return `<div class="card promo"><p class="verdict">${esc(p.verdict)}</p>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}</div>`;
  }
  lines.push(
    `Candidate: ${p.candidate.version} (testers), out ${hours(f.now.getTime() - p.candidate.shipped.getTime())}, ${p.regressions === undefined ? "regressions unknown" : `${p.regressions} regression${p.regressions === 1 ? "" : "s"} open`}.`,
  );
  const checks = [
    `4 hours since the newest rc: ${p.clockLeftMs > 0 ? `${hours(p.clockLeftMs)} left` : "done"}.`,
    `No open regression issue: ${p.regressions ?? "unknown"} open.`,
    "Your yes on a card.",
  ];
  return `<div class="card promo"><p class="verdict">${esc(p.candidate.version)} becomes ${esc(p.becomes)}: ${esc(p.verdict)}</p>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
<p class="label">Earliest</p><p>${esc(both(p.earliest))}. A newer rc restarts the clock.</p>${p.holdsNewRc ? `<p>No new rc while this waits for your yes</p>` : ""}
<p class="label">Needs</p><ul>${checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
<p>Promoting republishes ${esc(p.candidate.version)}'s builds as ${esc(p.becomes)} for everyone, with no rebuild; the Final column under Now shows where finals go. New work then goes to ${esc(p.nextRc ?? "")}.</p></div>`;
}

/** -1, 0 or 1: releases by version, an rc before its final, "unknown" last. */
export function compareVersions(a: string, b: string): number {
  if (a === "unknown" || b === "unknown") return a === b ? 0 : a === "unknown" ? 1 : -1;
  const part = (v: string) => {
    const [core = "", pre] = v.split("-");
    const [x = 0, y = 0, z = 0] = core.split(".").map(Number);
    const [kind = "", n = "0"] = (pre ?? "").split(".");
    return [x, y, z, pre === undefined ? 1 : 0, kind, Number(n)] as const;
  };
  const [pa, pb] = [part(a), part(b)];
  for (let i = 0; i < 6; i++) {
    const [x, y] = [pa[i] as string | number, pb[i] as string | number];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type RcBugs = { version: string; bugs: Bug[] };

/** Bugs by the version they were found in, newest first: every version with a bug, and the newest rc even with none. */
export function bugsByVersion(f: Facts): RcBugs[] {
  const by = new Map<string, Bug[]>();
  for (const b of f.bugs ?? []) by.set(b.foundIn, [...(by.get(b.foundIn) ?? []), b]);
  const rc = newest(f.releases, "rc");
  if (rc && !by.has(rc.version)) by.set(rc.version, []);
  return [...by]
    .sort(([a], [b]) =>
      a === "unknown" || b === "unknown" ? compareVersions(a, b) : compareVersions(b, a),
    )
    .map(([version, bugs]) => ({
      version,
      bugs: bugs.sort((a, b) => Number(b.open) - Number(a.open) || a.number - b.number),
    }));
}

const issueLink = (b: Bug) =>
  `<a href="https://github.com/${REPO}/issues/${b.number}">#${b.number}</a> ${esc(b.title)}`;

function fate(b: Bug): string {
  if (b.open) return "open";
  if (b.fixedIn)
    return `fixed in <a href="https://github.com/${REPO}/releases/tag/${esc(b.fixedIn)}">${esc(b.fixedIn)}</a>`;
  return b.closedByHand ? "closed without a fix" : "fixed on main, in no tag yet";
}

function bugsHtml(f: Facts): string {
  if (!f.bugs || !f.regressions)
    return `<div class="card promo"><p>GitHub did not answer: bugs unknown.</p></div>`;
  const reg = f.regressions.length
    ? `<ul>${f.regressions.map((b) => `<li>${issueLink(b)} <span class="meta">found in ${esc(b.foundIn)}</span></li>`).join("")}</ul>`
    : `<p>None open.</p>`;
  const groups = bugsByVersion(f)
    .map(({ version, bugs }) => {
      const known = f.releases.releases.some((e) => e.version === version);
      const name = known
        ? `<a href="https://github.com/${REPO}/releases/tag/v${esc(version)}">${esc(version)}</a>`
        : esc(version);
      const open = bugs.filter((b) => b.open).length;
      const count = bugs.length ? `${bugs.length} found, ${open} open` : "none found";
      const list = bugs.length
        ? `<ul>${bugs.map((b) => `<li>${issueLink(b)}${b.regression ? ` <span class="reg">regression</span>` : ""}: ${fate(b)}</li>`).join("")}</ul>`
        : "";
      return `<div class="rcbugs"><p class="name">${name} <span class="meta">${count}</span></p>${list}</div>`;
    })
    .join("");
  return `<div class="card bugs"><div class="rcbugs"><p class="name">Open regressions</p>${reg}</div>${groups}</div>`;
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
<title>Ops · Starbridge</title><link rel="icon" href="favicon.ico" sizes="48x48"><link rel="icon" href="icon.svg" type="image/svg+xml"><link rel="preload" href="fonts/google-sans-flex.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body><main>
<header><span class="brand">${MARK}Starbridge ops</span></header>
<div class="card intro"><h1>Rings</h1><p>Main: staging.starbridge.run, your phone.<br>rc: testers, starbridge.run.<br>Final: everyone.</p><p><a href="https://github.com/${REPO}/blob/main/spec/releases.md">spec/releases.md</a> · <a href="${POLICY}">Policy</a></p></div>
<section><h2>Next final</h2>${promotionHtml(f)}</section>
<section><h2>Bugs by release</h2>${bugsHtml(f)}</section>
<section><h2>Now</h2><div class="card prods">${rows}</div></section>
<section><h2>Next</h2><div class="card next"><ul>${nextRows}</ul></div></section>
<footer><p>As of ${both(f.now)}</p></footer></main></body></html>`;
}

const MARK = `<svg class="mark" width="20" height="20" viewBox="29.25 24.75 49.5 49.5" aria-hidden="true"><path class="fg" d="M29.25,72.75 V58.5 A24.75,24.75 0 0 1 78.75,58.5 V72.75 A1.5,1.5 0 0 1 77.25,74.25 H71.25 A1.5,1.5 0 0 1 69.75,72.75 V58.5 A9.25,9.25 0 0 0 51.25,58.5 V72.75 A1.5,1.5 0 0 1 49.75,74.25 H30.75 A1.5,1.5 0 0 1 29.25,72.75 Z"/><circle class="dot" cx="60.5" cy="68.75" r="5.5"/></svg>`;

// DESIGN.md's tokens as the status page's Ledger look uses them, light then dark.
const CSS = `@font-face{font-family:"Google Sans Flex";src:url(fonts/google-sans-flex.woff2) format("woff2");font-weight:1 1000;font-display:swap}
:root{--bg:#f4f4f4;--surface:#fff;--surface2:#ebebeb;--line:#e0e0e0;--fg:#121212;--fg2:#595959;--fg3:#6a6a6a;--accent:#965700;--sans:"Google Sans Flex","Roboto Flex",system-ui,-apple-system,sans-serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0c0c0c;--surface:#171717;--surface2:#232323;--line:#2a2a2a;--fg:#f1f1f1;--fg2:#a3a3a3;--fg3:#8a8a8a;--accent:#f5a83b}}
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
.promo{padding:16px 24px 8px}.promo p{margin:0 0 8px}.promo .label{margin:16px 0 4px}.promo ul{margin:0 0 8px;padding-left:20px}.promo li{padding:2px 0}
.verdict{font:500 18px/24px var(--sans)}
.bugs{padding:4px 24px}.rcbugs{padding:20px 0;border-top:1px solid var(--line)}.rcbugs:first-child{border-top:0}.rcbugs p{margin:0}.rcbugs .name{font:500 16px/24px var(--sans)}.rcbugs ul{margin:8px 0 0;padding-left:20px}.rcbugs li{padding:2px 0}.reg{font:500 13px/20px var(--sans);color:var(--accent)}
.next{padding:16px 24px}.next ul{margin:0;padding-left:20px}.next li{padding:4px 0}
footer{color:var(--fg2);font:400 13px/20px var(--sans)}
@media (max-width:700px){main{padding:24px 16px 48px}.intro{padding:20px;margin:24px 0 32px}.prods,.next,.promo,.bugs{padding-left:16px;padding-right:16px}.rings{grid-template-columns:1fr;gap:12px}}`;

function sh(cmd: string, ...args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

// The Mac app's tip builds (desktop.yml, desktop/scripts/tip.ts): a public repository.
const TIP_REPO = "T0mSIlver/starbridge-tip";
// What the Mac app is built from: APP_PATHS in desktop/scripts/tip.ts.
const MAC_PATHS = ["desktop", "pnpm-lock.yaml", ".github/workflows/desktop.yml"];

async function api<T>(
  path: string,
  accept = "application/vnd.github+json",
  repo = REPO,
): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
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

type IssueRow = {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  pull_request?: unknown;
};

function bug(i: IssueRow): Bug {
  const label = i.labels.find((l) => l.name.startsWith(LABEL_PREFIX));
  return {
    number: i.number,
    title: i.title,
    open: i.state === "open",
    foundIn: label ? label.name.slice(LABEL_PREFIX.length) : "unknown",
    regression: i.labels.some((l) => l.name === "regression"),
  };
}

/** The first tag holding a commit: "" when none does (or the clone lacks the commit). */
function firstTag(sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) return "";
  return (
    sh("git", "tag", "--contains", sha, "--list", "v*", "--sort=creatordate").split("\n")[0] ?? ""
  );
}

/**
 * Every issue with a `found-in:` label (#1890). Fixed-in is not stored: it is the first tag that
 * holds the commit that closed the issue, which a squash-merged PR's "Closes #n" records on the
 * issue's closed event. Undefined when GitHub did not answer.
 */
async function gatherBugs(): Promise<Bug[] | undefined> {
  const out: Bug[] = [];
  const seen = new Set<number>();
  const labels = await pages<{ name: string }>("labels?per_page=100");
  if (!labels) return undefined;
  for (const l of labels.filter((l) => l.name.startsWith(LABEL_PREFIX))) {
    const rows = await pages<IssueRow>(
      `issues?labels=${encodeURIComponent(l.name)}&state=all&per_page=100`,
    );
    if (!rows) return undefined;
    for (const row of rows.filter((i) => !i.pull_request && !seen.has(i.number))) {
      seen.add(row.number);
      const b = bug(row);
      if (!b.open) {
        const events = await pages<{ event: string; commit_id: string | null }>(
          `issues/${row.number}/events?per_page=100`,
        );
        if (!events) return undefined;
        const closed = events.filter((e) => e.event === "closed").pop();
        if (closed?.commit_id) b.fixedIn = firstTag(closed.commit_id) || undefined;
        else b.closedByHand = true;
      }
      out.push(b);
    }
  }
  return out;
}

/** Every page of a list endpoint, up to 10; undefined when any page fails. */
async function pages<T>(path: string): Promise<T[] | undefined> {
  const all: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await api<T[]>(`${path}&page=${page}`);
    if (!rows) return undefined;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

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
  // The newest internal run whose play job built the app; runs that skip the upload do not count, so look through pages.
  let internalBuild: Facts["internalBuild"];
  for (let page = 1; page <= 10 && !internalBuild; page++) {
    const runs = await api<{
      workflow_runs: { id: number; head_sha: string; created_at: string }[];
    }>(`actions/workflows/internal.yml/runs?status=completed&per_page=30&page=${page}`);
    if (!runs?.workflow_runs.length) break;
    for (const r of runs.workflow_runs) {
      const jobs = await api<{ jobs: { name: string; conclusion: string }[] }>(
        `actions/runs/${r.id}/jobs`,
      );
      if (jobs?.jobs.some((j) => j.name === "play" && j.conclusion === "success")) {
        internalBuild = { sha: r.head_sha, at: r.created_at };
        break;
      }
    }
  }
  // The tip release's tip.json names the build; the file's upload time is when it was published.
  let tipBuild: Facts["tipBuild"];
  const tip = await api<{ assets: { name: string; url: string; updated_at: string }[] }>(
    "releases/tags/tip",
    undefined,
    TIP_REPO,
  );
  const asset = tip?.assets.find((a) => a.name === "tip.json");
  if (asset) {
    const body = await api<{ version?: string; commit?: string }>(
      asset.url.slice(asset.url.indexOf("/releases/") + 1),
      "application/octet-stream",
      TIP_REPO,
    );
    if (body?.version && body.commit && /^[0-9a-f]{40}$/.test(body.commit))
      tipBuild = { version: body.version, sha: body.commit, at: asset.updated_at };
  }
  const commits: Record<string, string> = {};
  for (const e of data.releases) commits[e.version] = sh("git", "rev-list", "-n1", `v${e.version}`);
  const rc = newest(data, "rc");
  const regIssues = await api<IssueRow[]>("issues?labels=regression&state=open&per_page=100");
  const regressions = regIssues?.filter((i) => !i.pull_request).map((i) => bug(i));
  const bugs = await gatherBugs();
  return {
    now: new Date(),
    releases: data,
    prod,
    staging,
    internalBuild,
    androidSince: internalBuild
      ? count(`${internalBuild.sha}..origin/main`, "android", "packages/protocol/vectors")
      : undefined,
    androidChanged: internalBuild
      ? spawnSync("git", [
          "diff",
          "--quiet",
          internalBuild.sha,
          "origin/main",
          "--",
          "android",
          "packages/protocol/vectors",
        ]).status !== 0
      : undefined,
    tipBuild,
    macSince: tipBuild ? count(`${tipBuild.sha}..origin/main`, ...MAC_PATHS) : undefined,
    macChanged: tipBuild
      ? spawnSync("git", ["diff", "--quiet", tipBuild.sha, "origin/main", "--", ...MAC_PATHS])
          .status !== 0
      : undefined,
    stagingSinceRc: rc && staging ? count(`v${rc.version}..${staging}`) : undefined,
    commits,
    openRegressions: regressions?.length,
    regressions,
    bugs,
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
  copyFileSync("web/src/app/icon.svg", join(out, "icon.svg"));
}
