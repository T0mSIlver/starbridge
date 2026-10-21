// What a link chip shows: its icon and its text (spec/items.md, "Links"). Every client draws it
// from this rule, which vectors/links.json keeps in step. A link that matches no rule exactly
// keeps the plain chip: no icon, its title then its host, else its host and path. Nothing here
// fetches the URL.

/** A chip's icon: GitHub's Octicons for GitHub's kinds (#971), a window for a Claude artifact. */
export type LinkIcon =
  | "pull"
  | "issue"
  | "discussion"
  | "run"
  | "release"
  | "commit"
  | "file"
  | "github"
  | "artifact";

export type LinkChip = { icon?: LinkIcon; label: string };

/**
 * A link's chip (#971, #1577). A GitHub pull request, issue or discussion reads "#123", a release
 * its tag, a commit its short hash, each led by the repo when it isn't `project`, the session's;
 * the icon says what the number is, so the agent's title gives way. Another GitHub page and a
 * Claude artifact read as the agent's title, else a GitHub file its name, a run "Actions run",
 * another GitHub page its path, an artifact "Claude artifact". Any other host shows its host and
 * path, never the agent's title: only those two sites, whose icons name them, get a chip in the
 * agent's words, so no title dresses another site as one of them (#1722, #2203). A title with
 * hidden or reordering characters counts as none. A link that can't be read shows as written.
 */
export function linkChip(link: { url: string; title?: string }, project = ""): LinkChip {
  const url = parseUrl(link.url);
  if (!url) return { label: clip(link.url) };
  const gh = GITHUB_HOSTS.has(url.host) ? github(url.path) : undefined;
  if (gh?.ref) {
    const same = asciiLower(gh.repo) === asciiLower(project);
    const sep = gh.ref.startsWith("#") ? "" : " ";
    return { icon: gh.icon, label: clip(same ? gh.ref : `${gh.repo}${sep}${gh.ref}`) };
  }
  const title = link.title && !hidden(link.title) ? link.title : undefined;
  if (gh) return { icon: gh.icon, label: title ?? clip(gh.text) };
  const host = url.host.replace(/^www\./, "");
  if (url.host === "claude.ai" && ARTIFACT.test(url.path))
    return { icon: "artifact", label: title ?? "Claude artifact" };
  return { label: clip(`${host}${url.path === "/" ? "" : url.path}`) };
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
// claude.ai/artifact/<id>, /code/artifact/<id> and the shared /public/artifacts/<id>.
const ARTIFACT = /^\/(artifact|code\/artifact|public\/artifacts)\/[A-Za-z0-9_-]{1,64}\/?$/;

/**
 * The host (lowercase) and path of an https URL, read by hand rather than by each platform's URL
 * parser, which disagree at the edges. An authority with anything but letters, digits, dots and
 * hyphens (a user, a port, a backslash) gives undefined, so the chip shows the URL as written.
 */
function parseUrl(url: string): { host: string; path: string } | undefined {
  if (!url.startsWith("https://") || url.includes("\\")) return undefined;
  const rest = url.slice("https://".length);
  const end = rest.search(/[/?#]/);
  const host = end < 0 ? rest : rest.slice(0, end);
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return undefined;
  const tail = end < 0 ? "" : rest.slice(end);
  const path = tail.split(/[?#]/)[0] ?? "";
  // A "." or ".." segment, even percent-encoded, makes the browser open another page than the
  // path reads: show the URL as written.
  if (path.split("/").some((s) => DOTS.test(s))) return undefined;
  return { host: asciiLower(host), path: path || "/" };
}

const DOTS = /^(\.|%2e){1,2}$/i;
/** ASCII letters lowercased, the same in every port; GitHub's names are ASCII. */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

type GitHub = { icon: LinkIcon; repo: string; ref?: string; text: string };

/** What a github.com path points at; `text` is the label for a page with no ref. */
function github(path: string): GitHub {
  // A loop, not /\/+$/, which backtracks quadratically over a long run of slashes.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  const trimmed = path.slice(0, end);
  const segments = trimmed.split("/");
  const [, owner, name, section, a = "", b = ""] = segments;
  const repo = owner && name ? name : "";
  const other: GitHub = { icon: "github", repo, text: trimmed.slice(1) || "GitHub" };
  if (!repo) return other;
  const number = (icon: LinkIcon): GitHub =>
    DIGITS.test(a) ? { icon, repo, ref: `#${a}`, text: other.text } : other;
  if (section === "pull") return number("pull");
  if (section === "issues") return number("issue");
  if (section === "discussions") return number("discussion");
  if (section === "actions" && a === "runs" && DIGITS.test(b))
    return { icon: "run", repo, text: "Actions run" };
  if (section === "releases" && a === "tag" && b)
    return { icon: "release", repo, ref: decode(b), text: other.text };
  if (section === "commit" && SHA.test(a))
    return { icon: "commit", repo, ref: asciiLower(a.slice(0, 7)), text: other.text };
  // /blob/<ref>/<path>: a branch may hold slashes, but the last segment is always the file.
  const file = segments[segments.length - 1] ?? "";
  if (section === "blob" && a && segments.length > 5 && file)
    return { icon: "file", repo, text: decode(file) };
  return other;
}

const DIGITS = /^[0-9]{1,20}$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;
// Characters that would hide or reorder what a chip says: controls, bidi marks and the rest of
// Unicode's default-ignorable code points (soft hyphen, zero-width, variation selectors, tags).
const HIDDEN: [number, number][] = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
];
const hidden = (text: string) =>
  Array.from(text).some((c) => {
    const p = c.codePointAt(0) ?? 0;
    return HIDDEN.some(([lo, hi]) => p >= lo && p <= hi);
  });

/** A percent-decoded segment, else the segment as written when it is malformed or decodes to a
 * character that would hide or reorder the chip's text. */
function decode(segment: string): string {
  let text: string;
  try {
    text = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  return hidden(text) ? segment : text;
}

/** At most `max` code points, the last an ellipsis when cut; never half a surrogate pair. */
function clip(text: string, max = 40): string {
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}
