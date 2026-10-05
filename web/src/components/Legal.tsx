import { Analytics } from "./Analytics";
import { Mark } from "./icons";
import s from "./Legal.module.css";

/** A plain text page: /privacy and /terms, in a 68-character column under the brand. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={s.frame}>
      <Analytics />
      <header className={s.top}>
        <a href="/" className={`t-action ${s.brand}`}>
          <Mark size={20} />
          Starbridge
        </a>
      </header>
      <main className={`${s.page} t-body`}>
        <h1 className="t-title">{title}</h1>
        {children}
      </main>
      <footer className={s.foot}>
        <LegalLinks />
      </footer>
    </div>
  );
}

export function LegalLinks() {
  return (
    <nav className={`${s.links} t-meta`} aria-label="Legal">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a>
    </nav>
  );
}
