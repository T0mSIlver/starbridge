// A pull request's evidence comment (docs/ci.md, "Evidence"): compares the screenshots of its
// end-to-end run with main's at its base, pushes the changed pairs to the pr-shots branch, and
// writes or updates one comment on the pull request.
//
//   bun web/e2e/evidence.ts <pr dir> <base dir> <out dir>
//
// Each dir holds one folder per part of the run (EVIDENCE in run.ts): manifest.json and shots/.
// Without GITHUB_TOKEN it compares with what <base dir> holds and only writes <out dir>/comment.md
// and the changed pairs, for a run by hand. With it, it downloads main's evidence into <base dir>
// first, from a checkout of the pull request's merge with main, and pushes and comments; env: PR,
// SHA (the pull request's head), RUN_URL, GITHUB_REPOSITORY, GITHUB_API_URL. CLIENT names the
// run, `web` (the default), `android` (demo/smoke/android.ts with EVIDENCE set) or `desktop`
// (desktop/test/stack.ts with EVIDENCE set).
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Rect } from "./volatile.ts";

/**
 * What each client's run is, and its artifacts' and comment's names. `marker` finds the comment
 * again on the next push; no marker starts with another.
 */
const CLIENTS = {
  web: {
    artifact: "evidence",
    marker: "<!-- starbridge-evidence -->",
    run: "The web end-to-end run",
    held: "Screenshots at 360, 768 and 1280 px, light and dark, and Playwright traces",
    notDriven: "the Android, iOS and desktop apps",
  },
  android: {
    artifact: "android-evidence",
    marker: "<!-- starbridge-evidence android -->",
    run: "The Android app on the emulator",
    held: "Screenshots on a phone and a tablet, light and dark, with their UI dumps",
    notDriven:
      "answering from the app, a real device's launcher and fonts, the web, iOS and desktop apps",
  },
  desktop: {
    artifact: "desktop-evidence",
    marker: "<!-- starbridge-evidence desktop -->",
    run: "The desktop app's end-to-end run",
    held: "Screenshots of the window, light and dark",
    notDriven:
      "the menu bar icon (the run has no menu bar), macOS's own notifications and window frame, the web, Android and iOS apps",
  },
} as const;
export type Client = keyof typeof CLIENTS;
/** A pixel differs when a channel moves by more than this, which antialiasing stays under. */
const TOLERANCE = 24;
/**
 * A screen changed when more than this share of its pixels differ. Two runs of the same tree
 * differ in what each run makes up (a recovery key, pairing codes, times), up to about this.
 */
const CHANGED = 0.002;
/**
 * How many of the base's first parents to look through for main's evidence. Main's Android run
 * runs only on merges that touch the app, so it can be far back; the checkout fetches this deep.
 */
const DEPTH = 30;
/** Pairs shown inline and pushed to pr-shots; past it, the comment names the rest. */
const SHOWN = 24;

type Manifest = { shard: string; passed: boolean; error?: string; steps: string[] };
type Part = { dir: string; manifest: Manifest };

export function parts(root: string): Part[] {
  if (!existsSync(root)) return [];
  // download-artifact puts a lone artifact's files in the folder itself, not in a subfolder.
  const folders = existsSync(join(root, "manifest.json"))
    ? [root]
    : readdirSync(root).map((d) => join(root, d));
  return folders
    .filter((d) => existsSync(join(d, "manifest.json")))
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) }))
    .sort((a, b) => a.manifest.shard.localeCompare(b.manifest.shard));
}

/** Every screenshot by name; the parts all shoot the first device's setup, so the first wins. */
export function shots(ps: Part[]): Map<string, string> {
  const all = new Map<string, string>();
  for (const p of ps) {
    const dir = join(p.dir, "shots");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort())
      if (f.endsWith(".png") && !all.has(f)) all.set(f, join(dir, f));
  }
  return all;
}

/** The boxes run.ts saw change from run to run (volatile.ts), beside a screenshot. */
function skipped(png: string): Rect[] {
  const path = png.replace(/\.png$/, ".json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

/** The share of pixels that differ outside `skip`, 1 when the sizes do. */
export function difference(a: Buffer, b: Buffer, skip: Rect[] = []): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return 1;
  const out = new Uint8Array(x.width * x.height);
  for (const r of skip)
    for (
      let row = Math.max(0, Math.floor(r.y));
      row < Math.min(x.height, Math.ceil(r.y + r.height));
      row++
    )
      out.fill(
        1,
        row * x.width + Math.max(0, Math.floor(r.x)),
        row * x.width + Math.min(x.width, Math.ceil(r.x + r.width)),
      );
  let differ = 0;
  for (let p = 0; p < out.length; p++) {
    if (out[p]) continue;
    for (let c = 0; c < 4; c++)
      if (Math.abs((x.data[p * 4 + c] as number) - (y.data[p * 4 + c] as number)) > TOLERANCE) {
        differ++;
        break;
      }
  }
  return differ / (x.width * x.height);
}

export type Change = { name: string; kind: "changed" | "new" | "gone"; share?: number };

export function compare(pr: Map<string, string>, base: Map<string, string>): Change[] {
  const out: Change[] = [];
  for (const [name, path] of pr) {
    const before = base.get(name);
    if (!before) out.push({ name, kind: "new" });
    else {
      const share = difference(readFileSync(before), readFileSync(path), [
        ...skipped(before),
        ...skipped(path),
      ]);
      if (share > CHANGED) out.push({ name, kind: "changed", share });
    }
  }
  for (const name of base.keys()) if (!pr.has(name)) out.push({ name, kind: "gone" });
  // The pairs that differ most first, so the cut at SHOWN drops the faintest.
  return out.sort((a, b) => (b.share ?? 1) - (a.share ?? 1) || a.name.localeCompare(b.name));
}

type Context = {
  client: Client;
  sha: string;
  baseSha?: string;
  runUrl: string;
  /** Where the pushed pairs are served, ending in a slash; none when nothing was pushed. */
  images?: string;
};

/**
 * The changed screens by name, one entry for a screen's sizes and colour schemes, with how many
 * pairs changed: a change in the page itself shows in all of them, a flicker in one or two.
 */
export function screens(changes: Change[]): string {
  const by = new Map<string, number>();
  for (const c of changes) {
    const screen = c.name
      .replace(/\.png$/, "")
      .replace(/-(light|dark)$/, "")
      .replace(/-(phone|tablet|desktop|wide|table-edge)$/, "");
    by.set(screen, (by.get(screen) ?? 0) + 1);
  }
  return [...by].map(([name, n]) => `\`${name}\` ${n}`).join(", ");
}

/** The comment's text. */
export function render(
  pr: Part[],
  base: Part[],
  changes: Change[],
  total: number,
  ctx: Context,
): string {
  const client = CLIENTS[ctx.client];
  const lines = [client.marker, `### Evidence for ${ctx.sha.slice(0, 7)}`, ""];
  if (pr.length === 0) {
    lines.push(`${client.run} did not run: none of this pull request's files can affect it.`);
    return `${lines.join("\n")}\n`;
  }
  const failed = pr.filter((p) => !p.manifest.passed);
  lines.push(
    failed.length
      ? `**The run failed** in ${failed.map((p) => p.manifest.shard).join(", ")}: its evidence stops at the failing step.`
      : `${client.run} passed in ${pr.map((p) => p.manifest.shard).join(", ")}.`,
    "",
  );
  for (const p of failed)
    lines.push("```", (p.manifest.error ?? "").split("\n").slice(0, 6).join("\n"), "```", "");
  lines.push("<details><summary>Steps driven</summary>", "");
  for (const p of pr) {
    lines.push(`**${p.manifest.shard}**`, "");
    for (const s of p.manifest.steps) lines.push(`- ${s}`);
    lines.push("");
  }
  lines.push("</details>", "");

  const at = ctx.baseSha ? `main at ${ctx.baseSha.slice(0, 7)}` : "main";
  if (base.length === 0)
    lines.push(`No screenshots of ${at} to compare with: ${total} screenshots in the artifacts.`);
  else if (changes.length === 0) lines.push(`No visual change: ${total} screenshots match ${at}.`);
  else {
    const count = (k: Change["kind"]) => changes.filter((c) => c.kind === k).length;
    lines.push(
      `Against ${at}: ${count("changed")} changed, ${count("new")} new, ${count("gone")} gone, of ${total} screenshots.`,
      "",
    );
    lines.push(`Screens: ${screens(changes)}.`, "");
    const shown = changes.filter((c) => c.kind !== "gone").slice(0, SHOWN);
    if (ctx.images && shown.length) {
      lines.push("| Screen | Before | After |", "|---|---|---|");
      for (const c of shown) {
        const stem = c.name.replace(/\.png$/, "");
        const share = c.share === undefined ? "" : ` (${(c.share * 100).toFixed(1)}%)`;
        const before =
          c.kind === "new" ? "new" : `<img src="${ctx.images}${stem}-before.png" width="240">`;
        lines.push(
          `| \`${stem}\`${share} | ${before} | <img src="${ctx.images}${stem}-after.png" width="240"> |`,
        );
      }
      lines.push("");
    }
    const rest = changes.filter((c) => !shown.includes(c));
    if (rest.length) {
      lines.push(`<details><summary>${rest.length} more</summary>`, "");
      for (const c of rest) lines.push(`- \`${c.name}\` ${c.kind}`);
      lines.push("", "</details>", "");
    }
  }
  lines.push(
    "",
    `${client.held}: [the run's artifacts](${ctx.runUrl}).`,
    `Not driven here: ${client.notDriven}.`,
  );
  return `${lines.join("\n")}\n`;
}

function git(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Adds `dir` under `prefix` on top of pr-shots and pushes it, again on top of a newer tip when
 * another run pushed first. Plumbing only, on a temporary index: the checkout stays as it is.
 * Returns the pushed commit.
 */
function pushShots(dir: string, prefix: string, message: string): string {
  const index = { GIT_INDEX_FILE: join(dir, "..", "pr-shots.index") };
  for (let tries = 1; ; tries++) {
    git([
      "fetch",
      "--quiet",
      "--depth=1",
      "origin",
      "+refs/heads/pr-shots:refs/remotes/origin/pr-shots",
    ]);
    const tip = git(["rev-parse", "refs/remotes/origin/pr-shots"]);
    git(["read-tree", tip], index);
    for (const f of readdirSync(dir)) {
      const blob = git(["hash-object", "-w", join(dir, f)]);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${prefix}/${f}`], index);
    }
    const tree = git(["write-tree"], index);
    // GitHub's runners have no git identity; the commit is the workflow's.
    const commit = git(["commit-tree", tree, "-p", tip, "-m", message], {
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    });
    const r = spawnSync("git", ["push", "--quiet", "origin", `${commit}:refs/heads/pr-shots`], {
      encoding: "utf8",
    });
    if (r.status === 0) return commit;
    if (tries === 5) throw new Error(`push to pr-shots: ${r.stderr}`);
    console.log(`pr-shots moved on, trying again (${tries})`);
  }
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(
    `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
    },
  );
  if (!res.ok)
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Updates the comment that holds the marker, or posts one. */
async function comment(pr: string, body: string, marker: string) {
  for (let page = 1; page <= 10; page++) {
    const list = (await api(`/issues/${pr}/comments?per_page=100&page=${page}`)) as {
      id: number;
      body: string;
    }[];
    const mine = list.find((c) => c.body.startsWith(marker));
    if (mine) {
      await api(`/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
      return;
    }
    if (list.length < 100) break;
  }
  await api(`/issues/${pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
}

/**
 * Downloads main's evidence into `dir`: what main's run of the pull request's base uploaded (CI
 * names a passing part's evidence after the tree it tested), or of the nearest of its first
 * parents with some, since a merge whose files cannot affect the run skips it. Returns the commit
 * found.
 */
async function fetchBase(
  dir: string,
  shards: string[],
  artifact: string,
): Promise<string | undefined> {
  const commits = git(["rev-list", "--first-parent", "-n", `${DEPTH}`, "HEAD^1"]).split("\n");
  for (const sha of commits) {
    const tree = git(["rev-parse", `${sha}^{tree}`]);
    let found = false;
    for (const shard of shards) {
      const { artifacts } = (await api(
        `/actions/artifacts?name=${artifact}-${shard}-${tree}&per_page=20`,
      )) as {
        artifacts: {
          expired: boolean;
          archive_download_url: string;
          workflow_run: {
            head_repository_id: number;
            repository_id: number;
            head_branch: string;
            head_sha: string;
          };
        }[];
      };
      // Only main's own runs of that commit: a pull request's job can upload any name (#1732).
      const a = artifacts.find(
        (x) =>
          !x.expired &&
          x.workflow_run.head_repository_id === x.workflow_run.repository_id &&
          x.workflow_run.head_branch === "main" &&
          x.workflow_run.head_sha === sha,
      );
      if (!a) continue;
      const res = await fetch(a.archive_download_url, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
      });
      if (!res.ok) throw new Error(`download ${a.archive_download_url}: ${res.status}`);
      const zip = join(dir, `${shard}.zip`);
      mkdirSync(join(dir, shard), { recursive: true });
      writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const r = spawnSync("unzip", ["-q", zip, "-d", join(dir, shard)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`unzip ${zip}: ${r.stderr}`);
      found = true;
    }
    if (found) return sha;
  }
  return undefined;
}

if (import.meta.main) {
  const [prDir, baseDir, outDir] = process.argv.slice(2);
  if (!prDir || !baseDir || !outDir) {
    console.error("usage: bun web/e2e/evidence.ts <pr dir> <base dir> <out dir>");
    process.exit(64);
  }
  const { PR, SHA = "local", RUN_URL = "", GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  const client = (process.env.CLIENT ?? "web") as Client;
  if (!(client in CLIENTS)) throw new Error(`CLIENT is ${Object.keys(CLIENTS).join(" or ")}`);
  const pr = parts(prDir);
  const baseSha =
    GITHUB_TOKEN && pr.length
      ? await fetchBase(
          baseDir,
          pr.map((p) => p.manifest.shard),
          CLIENTS[client].artifact,
        ).catch((e) => {
          // The comment still goes up, saying there was nothing to compare with.
          console.error("main's evidence:", e);
          return undefined;
        })
      : undefined;
  const base = parts(baseDir);
  const prShots = shots(pr);
  const changes = base.length ? compare(prShots, shots(base)) : [];
  const pairs = join(outDir, "pairs");
  mkdirSync(pairs, { recursive: true });
  const shown = changes.filter((c) => c.kind !== "gone").slice(0, SHOWN);
  const baseShots = shots(base);
  for (const c of shown) {
    const stem = c.name.replace(/\.png$/, "");
    copyFileSync(prShots.get(c.name) as string, join(pairs, `${stem}-after.png`));
    const before = baseShots.get(c.name);
    if (before) copyFileSync(before, join(pairs, `${stem}-before.png`));
  }
  let images: string | undefined;
  if (GITHUB_TOKEN && PR && shown.length) {
    const prefix = `verify/${PR}/${SHA}${client === "web" ? "" : `/${client}`}`;
    const commit = pushShots(pairs, prefix, `Evidence for #${PR} at ${SHA.slice(0, 7)}`);
    images = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${commit}/${prefix}/`;
  }
  const body = render(pr, base, changes, prShots.size, {
    client,
    sha: SHA,
    baseSha,
    runUrl: RUN_URL,
    images,
  });
  writeFileSync(join(outDir, "comment.md"), body);
  console.log(body);
  if (GITHUB_TOKEN && PR) await comment(PR, body, CLIENTS[client].marker);
}
