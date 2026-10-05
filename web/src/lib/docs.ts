import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { Marked, type Tokens } from "marked";
import { REPO } from "./links";

/**
 * The pages under /docs, in the nav's order: Markdown files of the repository. Each page shows
 * its title here in place of the file's own first heading.
 */
export const DOCS = [
  { slug: "", file: "docs/index.md", title: "Overview" },
  { slug: "cli", file: "cli/README.md", title: "The CLI" },
  { slug: "tell-your-agents", file: "docs/tell-your-agents.md", title: "Tell your agents" },
  { slug: "self-host", file: "server/README.md", title: "Self-host" },
] as const;

export type Doc = (typeof DOCS)[number];

const ROOT = join(process.cwd(), "..");

/** `/docs` or `/docs/<slug>`. */
export const docHref = (d: Doc) => (d.slug ? `/docs/${d.slug}` : "/docs");

/** A link in `file` as the docs serve it: another doc's page, else the file on GitHub. */
function rewrite(file: string, href: string): string {
  if (/^[a-z]+:|^#|^\//i.test(href)) return href;
  const [path = "", hash] = href.split("#");
  const target = normalize(join(dirname(file), path));
  const doc = DOCS.find((d) => d.file === target);
  const tail = hash ? `#${hash}` : "";
  if (doc) return docHref(doc) + tail;
  return `${REPO}/blob/main/${target}${tail}`;
}

const attr = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Reads a doc at build time, as HTML without its first heading. */
export function renderDoc(doc: Doc): string {
  const source = readFileSync(join(ROOT, doc.file), "utf8");
  const body = source.replace(/^# .*\n/, "");
  const ids = new Map<string, number>();
  const marked = new Marked({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const base =
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "section";
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        return `<h${depth} id="${id}"><a href="#${id}">${this.parser.parseInline(tokens)}</a></h${depth}>\n`;
      },
      code({ text }: Tokens.Code) {
        return `<div data-code><pre><code>${attr(text)}</code></pre><button type="button" data-copy aria-label="Copy"></button></div>\n`;
      },
      link({ href, title: t, tokens }: Tokens.Link) {
        const to = rewrite(doc.file, href);
        const external = /^https?:/.test(to) ? ' rel="noreferrer"' : "";
        const titled = t ? ` title="${attr(t)}"` : "";
        return `<a href="${attr(to)}"${titled}${external}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  return marked.parse(body, { async: false });
}
