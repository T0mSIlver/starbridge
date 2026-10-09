import type { DecisionLink, ShownImage } from "@starbridge/protocol";

/** An `<img>` source for an attached image; the protocol carries it as base64url. */
export function imageSrc(img: ShownImage): string {
  const b64 = img.data.replace(/-/g, "+").replace(/_/g, "/");
  return `data:${img.type};base64,${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`;
}

/** What a GitHub link points at: each kind has its Octicon on the chip (#971). */
export type GitHubKind = "pull" | "issue" | "discussion" | "run" | "release" | "commit" | "other";

export type GitHubLink = {
  kind: GitHubKind;
  repo: string;
  /** "#123", a release's tag or a commit's short hash; undefined for a run or another page. */
  ref?: string;
  /** The path after github.com, for a page with no ref. */
  path: string;
};

/** What a github.com link points at, else undefined. */
export function githubLink(link: string): GitHubLink | undefined {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  const [, owner, name, section, a, b] = path.split("/");
  const repo = owner && name ? name : "";
  const other: GitHubLink = { kind: "other", repo, path: path.slice(1) };
  if (!repo) return other;
  const number = (kind: GitHubKind) =>
    /^\d+$/.test(a ?? "") ? { kind, repo, ref: `#${a}`, path: other.path } : other;
  if (section === "pull") return number("pull");
  if (section === "issues") return number("issue");
  if (section === "discussions") return number("discussion");
  if (section === "actions" && a === "runs" && /^\d+$/.test(b ?? ""))
    return { kind: "run", repo, path: other.path };
  if (section === "releases" && a === "tag" && b)
    return { kind: "release", repo, ref: decode(b), path: other.path };
  if (section === "commit" && /^[0-9a-f]{7,40}$/i.test(a ?? ""))
    return { kind: "commit", repo, ref: a.slice(0, 7), path: other.path };
  return other;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A link's chip text. A GitHub pull request, issue or discussion reads "#123", a release its tag,
 * a commit its short hash, led by the repo when it isn't `project`, the session's (#971); any
 * other link reads as its title, else "Actions run" for a run, "Claude artifact" for one, else
 * its host and path (a GitHub page's path alone, since its mark says GitHub).
 */
export function linkLabel(link: DecisionLink, project = ""): string {
  const gh = githubLink(link.url);
  if (gh?.ref) {
    const same = gh.repo.toLowerCase() === project.toLowerCase();
    return clip(same ? gh.ref : `${gh.repo}${gh.ref.startsWith("#") ? "" : " "}${gh.ref}`);
  }
  if (link.title) return link.title;
  if (gh?.kind === "run") return "Actions run";
  if (gh) return clip(gh.path || "GitHub");
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    // The schema accepts some https:// strings that URL refuses; show those as written.
    return clip(link.url);
  }
  if (url.hostname === "claude.ai" && /\/artifacts?\//.test(url.pathname)) return "Claude artifact";
  return clip(`${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`);
}

const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 39)}…` : text);
