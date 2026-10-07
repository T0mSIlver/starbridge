import { readFileSync, statSync } from "node:fs";
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
  { slug: "tell-your-agents", file: "docs/tell-your-agents.md", title: "Agent instructions" },
  { slug: "self-host", file: "server/README.md", title: "Self-host" },
  { slug: "faq", file: "docs/faq.md", title: "FAQ" },
] as const;

export type Doc = (typeof DOCS)[number];

// The deploy image holds these files through outputFileTracingIncludes (next.config.ts).
const ROOT = join(/* turbopackIgnore: true */ process.cwd(), "..");

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

// Each doc's HTML, kept until its file changes: every page renders per request for its CSP nonce
// (proxy.ts), but the nonce is in the layout, not in a doc's HTML (#588).
const rendered = new Map<string, { mtime: number; html: string }>();

/** A doc as HTML without its first heading, parsed again only when its file changes. */
export function renderDoc(doc: Doc): string {
  const path = join(ROOT, doc.file);
  const mtime = statSync(path).mtimeMs;
  const hit = rendered.get(doc.file);
  if (hit?.mtime === mtime) return hit.html;
  const html = parse(doc, readFileSync(path, "utf8"));
  rendered.set(doc.file, { mtime, html });
  return html;
}

function parse(doc: Doc, source: string): string {
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
      // A block without a language is text to paste, such as an agent's rules: it wraps.
      code({ text, lang }: Tokens.Code) {
        const wrap = lang ? "" : " data-wrap";
        return `<div data-code${wrap}><pre><code>${attr(text)}</code></pre><button type="button" data-copy aria-label="Copy"></button></div>\n`;
      },
      link({ href, title: t, tokens }: Tokens.Link) {
        const to = rewrite(doc.file, href);
        const external = /^https?:/.test(to) ? ' rel="noreferrer"' : "";
        const titled = t ? ` title="${attr(t)}"` : "";
        return `<a href="${attr(to)}"${titled}${external}>${this.parser.parseInline(tokens)}</a>`;
      },
      // An image under web/public, which the site serves from its root. A `-light` one comes with
      // its `-dark` twin; the stylesheet shows the one for the page's theme (Docs.module.css).
      image({ href, text }: Tokens.Image) {
        const target = normalize(join(dirname(doc.file), href));
        if (!target.startsWith("web/public/"))
          throw new Error(`${doc.file}: ${href} is not under web/public`);
        const src = target.slice("web/public".length);
        const light = /-light(\.\w+)$/;
        const img = (s: string, scheme?: string) =>
          `<img src="${attr(s)}" alt="${attr(text)}" loading="lazy"${scheme ? ` data-scheme="${scheme}"` : ""}>`;
        if (!light.test(src)) return img(src);
        return img(src.replace(light, "-dark$1"), "dark") + img(src, "light");
      },
    },
  });
  return marked.parse(body, { async: false });
}
