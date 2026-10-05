import type { CSSProperties } from "react";
import { status } from "@/lib/quota";
import { bar, type QuotaSettings, resetTime } from "@/lib/quotaSettings";
import type { QuotaCardData } from "@/lib/types";
import s from "./QuotaCard.module.css";
import ui from "./ui.module.css";

// The provider's colour from DESIGN.md, keyed by CodexBar's id; grey for a provider it lacks.
function dotStyle(provider: string): CSSProperties {
  const id = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { "--dot": `var(--provider-${id}, var(--fg3))` } as CSSProperties;
}

export function QuotaCard({
  q,
  settings,
  onNotify,
  now = new Date(),
}: {
  q: QuotaCardData;
  settings: QuotaSettings;
  /** Turns on this provider's notifications; offered on an alert card while they are off. */
  onNotify?: () => void;
  now?: Date;
}) {
  const { provider, window: w, alert } = q;
  const { state, word, detail, resets } = status(w, alert, now, (iso) =>
    resetTime(iso, settings, now),
  );
  const b = bar(w, settings, now);
  const label = `${provider} ${w.label} ${b.word}`;
  return (
    <article className={`${ui.card} ${s.card}`}>
      <div className={s.top}>
        <h2 className={`t-action ${s.name}`}>
          <span className={s.provider}>
            <span className={s.dot} style={dotStyle(provider)} aria-hidden="true" />
            {provider}
          </span>{" "}
          <span className={`t-small ${s.window}`}>{w.label}</span>
          {q.machine && <span className={`t-machine ${s.machine}`}>{q.machine}</span>}
        </h2>
        <span className="t-figure">
          {b.percent}
          <span className={s.percent}>% {b.word}</span>
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot draw the steady-pace mark */}
      <div
        className={s.bar}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={b.percent}
        aria-valuetext={`${b.percent}% ${b.word}${b.steady !== null ? `, steady pace ${b.steady}%` : ""}`}
      >
        {/* A filled part, a gap, the rest of the track with a stop mark at its end. */}
        {b.percent > 0 && (
          <span className={`${s.fill} ${s[state]}`} style={{ flexBasis: `${b.percent}%` }} />
        )}
        {b.percent < 100 && <span className={s.rest} />}
        {b.ticks.map((t) => (
          <span
            key={t}
            className={`${s.tick} ${settings.ticks === "high-contrast" ? s.strong : ""}`}
            style={{ left: `${t}%` }}
          />
        ))}
        {b.steady !== null && (
          <span
            className={s.expected}
            style={{ left: `${Math.min(b.steady, 100)}%` }}
            title={`A steady pace would be at ${b.steady}% ${b.word}`}
          />
        )}
      </div>
      <p className={`t-small ${s.facts}`}>
        <span className={`t-label ${s.word} ${s[state]}`}>{word}</span>
        <span>{resets}</span>
      </p>
      {detail && (
        <p className={`t-small ${s.alert}`} role="status">
          {detail}
        </p>
      )}
      {alert && onNotify && (
        <button type="button" className={`${ui.button} ${s.notify}`} onClick={onNotify}>
          Notify me next time
        </button>
      )}
    </article>
  );
}
