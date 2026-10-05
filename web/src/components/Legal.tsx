import s from "./Legal.module.css";

/** A plain text page: /privacy and /terms. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={`${s.page} t-body`}>
      <a href="/" className="t-heading">
        Starbridge
      </a>
      <h1 className="t-title">{title}</h1>
      {children}
      <LegalLinks />
    </main>
  );
}

export function LegalLinks() {
  return (
    <nav className={`${s.links} t-small`}>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="mailto:abuse@starbridge.run">abuse@starbridge.run</a>
    </nav>
  );
}
