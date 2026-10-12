/**
 * A release's notes, grouped by product, from the "Release notes" section of each merged pull request:
 *   GH_TOKEN=… bun cli/scripts/release-notes.ts <version> [head] > notes.md
 * A final covers every change since the previous final, rcs included; an rc covers the changes since
 * the tag before it, which is what its testers have not seen yet. A pull request without the section
 * shows only in the folded list of all pull requests, and is named on stderr.
 */
import { spawnSync } from "node:child_process";
import { compareVersions } from "../src/release";

/** The products a note can name, in the order the release shows them. */
export const PRODUCTS = ["Android", "Web", "Desktop", "CLI", "Server", "Docs"] as const;
export type Product = (typeof PRODUCTS)[number];

export type Change = { subject: string; pr?: number; body?: string };
export type Note = { product: Product; text: string; pr?: number };

/** The tag a version's notes start from: the newest final below it, or for an rc the newest tag of any kind. */
export function baseTag(version: string, tags: string[]): string | undefined {
  const rc = version.includes("-rc.");
  return tags
    .filter((t) => /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(t))
    .filter((t) => (rc || !t.includes("-rc.")) && compareVersions(t, version) < 0)
    .sort(compareVersions)
    .at(-1);
}

/** A squash commit's pull request: the last `(#n)` of its subject. */
export function prNumber(subject: string): number | undefined {
  const m = /\(#(\d+)\)$/.exec(subject.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * The notes in a pull request body's "Release notes" section, one per `Product: text` line, or
 * undefined when it has no such section. "None", with or without ": reason", and HTML comments are
 * not notes.
 */
export function parseNotes(
  body: string,
  pr?: number,
): { notes: Note[]; unknown: string[] } | undefined {
  // Removes comments until none is left, since removing one can join the pieces of another, then
  // an unclosed one with the rest of the body.
  let text = body;
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  }
  const lines = text.replace(/<!--[\s\S]*$/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+release notes?\s*$/i.test(l.trim()));
  if (start < 0) return undefined;
  const notes: Note[] = [];
  const unknown: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(raw.trim())) break;
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line || /^none(\.|:.*)?$/i.test(line)) continue;
    const m = /^([A-Za-z]+):\s*(.+)$/.exec(line);
    const product = m && PRODUCTS.find((p) => p.toLowerCase() === m[1]?.toLowerCase());
    if (m && product) notes.push({ product, text: (m[2] as string).trim(), pr });
    else unknown.push(line);
  }
  return { notes, unknown };
}

/** The release body: a section per product with notes, then every pull request, folded. */
export function render(changes: Change[], compare: string, repo: string): string {
  const notes = changes.flatMap((c) => (c.body ? (parseNotes(c.body, c.pr)?.notes ?? []) : []));
  const out: string[] = [];
  for (const product of PRODUCTS) {
    const mine = notes.filter((n) => n.product === product);
    if (mine.length === 0) continue;
    out.push(`### ${product}`, "");
    for (const n of mine) out.push(`- ${n.text}${n.pr ? ` (#${n.pr})` : ""}`);
    out.push("");
  }
  out.push(`<details><summary>All pull requests (${changes.length})</summary>`, "");
  for (const c of changes) out.push(`- ${c.subject}`);
  out.push(
    "",
    `**Full Changelog**: https://github.com/${repo}/compare/${compare}`,
    "",
    "</details>",
  );
  return `${out.join("\n")}\n`;
}

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function prBody(repo: string, pr: number, token: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`pull request #${pr}: HTTP ${res.status}`);
  return ((await res.json()) as { body: string | null }).body ?? "";
}

if (import.meta.main) {
  const [version, head = "HEAD"] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY ?? "T0mSIlver/starbridge";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!version || !token) throw new Error("usage: GH_TOKEN=… release-notes.ts <version> [head]");
  const tags = git("tag", "--list", "v*").split("\n").filter(Boolean);
  // A dry run of a version below every tag, like the workflow's default, starts from the newest.
  const base = baseTag(version, tags) ?? baseTag("999.0.0-rc.1", tags);
  if (!base) throw new Error("no release tag");
  const subjects = git("log", "--first-parent", "--format=%s", `${base}..${head}`)
    .split("\n")
    .filter(Boolean);
  const changes: Change[] = await Promise.all(
    subjects.map(async (subject) => {
      const pr = prNumber(subject);
      return { subject, pr, body: pr ? await prBody(repo, pr, token) : undefined };
    }),
  );
  for (const c of changes) {
    const parsed = c.body === undefined ? undefined : parseNotes(c.body, c.pr);
    if (!parsed) console.error(`no Release notes section: ${c.subject}`);
    for (const line of parsed?.unknown ?? [])
      console.error(`#${c.pr}: not "Product: text" with one of ${PRODUCTS.join(", ")}: ${line}`);
  }
  process.stdout.write(render(changes, `${base}...v${version}`, repo));
}
