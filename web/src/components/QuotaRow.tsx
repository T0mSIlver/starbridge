import { relative } from "@/lib/format";
import { status } from "@/lib/quota";
import { bar, type QuotaGroup as Group, type QuotaSettings } from "@/lib/quotaSettings";
import type { QuotaCardData } from "@/lib/types";
import { Meter } from "./Meter";
import s from "./QuotaRow.module.css";

/**
 * One provider's windows under its name, and the machine that sent them when there are several.
 * When CodexBar failed for it, its last windows stay, and the name says when they were read and
 * why they were not read again.
 */
export function QuotaGroup({
  g,
  settings,
  now,
  comfy = false,
  handle,
}: {
  g: Group;
  settings: QuotaSettings;
  now: Date;
  comfy?: boolean;
  /** The Quotas page's drag handle, before the provider's name. */
  handle?: React.ReactNode;
}) {
  return (
    <section className={`${s.group} ${comfy ? s.groupComfy : ""}`} aria-label={g.provider}>
      <div className={s.lead}>
        <h2 className={`${comfy ? "t-action" : "t-label"} ${s.head}`}>
          {handle}
          <span className={s.name}>{g.provider}</span>
          {g.machine && <span className={`t-meta ${s.dim}`}>{g.machine}</span>}
        </h2>
        {g.stale && (
          <p className={`t-meta ${s.stale}`}>
            <span>Updated {relative(g.stale.updatedAt, now)}</span>
            <span>{g.stale.error}</span>
          </p>
        )}
      </div>
      {g.cards.map((q) => (
        <QuotaRow key={q.window.id} q={q} settings={settings} now={now} comfy={comfy} />
      ))}
    </section>
  );
}

/** One quota window as a row under its provider: window name and figure, meter, status and reset. */
export function QuotaRow({
  q,
  settings,
  now,
  comfy = false,
}: {
  q: QuotaCardData;
  settings: QuotaSettings;
  now: Date;
  /** Larger, for phones and the Quotas page. */
  comfy?: boolean;
}) {
  const { provider, window: w, alert } = q;
  const st = status(w, alert, settings, now);
  const b = bar(w, settings, now);
  const figure = st.state === "ran-out" ? (settings.showUsed ? 100 : 0) : b.percent;
  return (
    <article className={`${s.row} ${comfy ? s.comfy : ""}`} aria-label={`${provider} ${w.label}`}>
      <div className={`${comfy ? "t-body" : "t-small"} ${s.top}`}>
        <span className={s.name}>{w.label}</span>
        <span className={s.figure}>
          {figure}% <span className={s.word}>{b.word}</span>
        </span>
      </div>
      <Meter
        provider={provider}
        label={w.label}
        w={w}
        state={st.state}
        settings={settings}
        now={now}
      />
      <div className={`${comfy ? "t-small" : "t-meta"} ${s.bottom}`}>
        <span className={`${s.state} ${s[st.state]}`}>{st.word}</span>
        <span className={`${s.dim} ${s.reset}`}>{st.reset}</span>
      </div>
    </article>
  );
}
