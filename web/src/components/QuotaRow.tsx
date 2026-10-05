import { status } from "@/lib/quota";
import { bar, type QuotaSettings } from "@/lib/quotaSettings";
import type { QuotaCardData } from "@/lib/types";
import { Meter } from "./Meter";
import s from "./QuotaRow.module.css";

/** One quota window as a row: name and figure, its meter, its status word and reset. */
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
        <span className={s.name}>
          {provider} <span className={s.dim}>{w.label}</span>
          {q.machine && <span className={s.dim}> · {q.machine}</span>}
        </span>
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
        <span className={s.dim}>{st.reset}</span>
      </div>
    </article>
  );
}
