import { DOCS, type Doc, docHref } from "@/lib/docs";
import { Analytics } from "./Analytics";
import { CopyCode } from "./CopyCode";
import s from "./Docs.module.css";
import { Mark } from "./icons";
import { LegalLinks } from "./Legal";

function Nav({ current }: { current: string }) {
  return (
    <ul className={s.navList}>
      {DOCS.map((d) => (
        <li key={d.slug}>
          <a href={docHref(d)} aria-current={d.slug === current ? "page" : undefined}>
            {d.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A page of the docs: the side nav on a wide screen, a menu above the text on a phone. */
export function DocsPage({ doc, html }: { doc: Doc; html: string }) {
  return (
    <div className={s.page}>
      <Analytics />
      <header className={s.top}>
        <a href="/" className={`t-subtitle ${s.brand}`}>
          <Mark size={22} />
          Starbridge
        </a>
        <a href="/docs" className={`t-label ${s.section}`}>
          Docs
        </a>
      </header>
      <details className={`t-small ${s.menu}`}>
        <summary>{doc.title}</summary>
        <nav aria-label="Docs">
          <Nav current={doc.slug} />
        </nav>
      </details>
      <div className={s.body}>
        <nav className={`t-small ${s.side}`} aria-label="Docs">
          <Nav current={doc.slug} />
        </nav>
        <main className={s.main}>
          <h1 className="t-title">{doc.title}</h1>
          <article
            className={`t-body ${s.text}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the repository's own Markdown, rendered at build time
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <CopyCode />
          <footer className={s.foot}>
            <LegalLinks />
          </footer>
        </main>
      </div>
    </div>
  );
}
