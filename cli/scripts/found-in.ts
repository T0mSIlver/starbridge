/**
 * Labels a new bug with the release it was found in (#1890):
 *   GH_TOKEN=… ISSUE_NUMBER=12 ISSUE_BODY=… GITHUB_REPOSITORY=owner/repo bun cli/scripts/found-in.ts
 * found-in.yml runs it when an issue is opened or edited. The bug form's required "Version" field
 * becomes a `found-in:<version>` label, or `found-in:unknown` when the field holds no version we
 * know. The issue's text is data: it reaches this script through the environment and only a
 * string matched by VERSION ever reaches a label name or a URL.
 */

export const LABEL_PREFIX = "found-in:";
const UNKNOWN = `${LABEL_PREFIX}unknown`;

// A release (0.1.8, v0.1.8) or an rc or tip build (0.1.8-rc.2, 0.1.8-tip.85), alone: not inside a
// longer dotted number, not followed by another suffix (0.1.8-beta). A build suffix such as
// Android's `+build` and a sentence's closing period are fine.
const VERSION = /(?<![\w.])v?(\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:rc|tip)\.\d{1,6})?)(?![\w-]|\.\w)/;

/** The text under the form's "Version" heading, which GitHub renders as `### Version`. */
function versionField(body: string): string | undefined {
  const m = /^###[ \t]+Version[ \t]*\r?\n([\s\S]*?)(?=^###[ \t]|(?![\s\S]))/im.exec(body);
  return m?.[1];
}

/** `found-in:0.1.8-rc.2` for the first version in the field, else `found-in:unknown`. */
export function foundIn(body: string | null | undefined): string {
  const v = VERSION.exec(versionField(body ?? "") ?? "")?.[1];
  return v ? LABEL_PREFIX + v : UNKNOWN;
}

type Label = { name: string };

/**
 * What to do to an issue's labels. A reporter fixing the version moves the label; one who leaves
 * the field unreadable does not take away a label the maintainer set by hand.
 */
export function plan(
  body: string | null | undefined,
  existing: string[],
): { add?: string; remove: string[] } {
  const want = foundIn(body);
  const have = existing.filter((l) => l.startsWith(LABEL_PREFIX));
  if (want === UNKNOWN && have.some((l) => l !== UNKNOWN)) return { remove: [] };
  return {
    add: have.includes(want) ? undefined : want,
    remove: have.filter((l) => l !== want),
  };
}

async function main() {
  const { GH_TOKEN, ISSUE_NUMBER, ISSUE_BODY, GITHUB_REPOSITORY } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^\d+$/.test(ISSUE_NUMBER ?? ""))
    throw new Error("needs GH_TOKEN, GITHUB_REPOSITORY and a numeric ISSUE_NUMBER");
  const base = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const issue = await call(`/issues/${ISSUE_NUMBER}`);
  if (!issue.ok) throw new Error(`reading issue ${ISSUE_NUMBER}: ${issue.status}`);
  const { labels } = (await issue.json()) as { labels: Label[] };
  const names = labels.map((l) => l.name);
  // Bugs only: the form puts `bug` on its issues, and a maintainer can add it to another.
  if (!names.includes("bug")) return;
  const { add, remove } = plan(ISSUE_BODY, names);
  for (const name of remove) {
    const r = await call(`/issues/${ISSUE_NUMBER}/labels/${encodeURIComponent(name)}`, "DELETE");
    if (!r.ok) throw new Error(`removing ${name}: ${r.status}`);
  }
  if (!add) return;
  // 422 is "already exists".
  const made = await call("/labels", "POST", {
    name: add,
    color: add === UNKNOWN ? "cfd3d7" : "fbca04",
    description: "The release the bug was reported in",
  });
  if (!made.ok && made.status !== 422) throw new Error(`creating ${add}: ${made.status}`);
  const r = await call(`/issues/${ISSUE_NUMBER}/labels`, "POST", { labels: [add] });
  if (!r.ok) throw new Error(`labelling ${ISSUE_NUMBER}: ${r.status}`);
  console.log(`#${ISSUE_NUMBER}: ${add}`);
}

if (import.meta.main) await main();
