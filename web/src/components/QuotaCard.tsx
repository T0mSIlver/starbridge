import { relative } from "@/lib/format";
import type { Pace, QuotaWindow } from "@/lib/types";
import s from "./QuotaCard.module.css";
import ui from "./ui.module.css";

// A tone always comes with a word (DESIGN.md).
const PACE: Record<Pace, { word: string; tone: string }> = {
  "on-pace": { word: "On pace", tone: ui.ok },
  "runs-out": { word: "Will run out", tone: ui.bad },
  unused: { word: "Headroom unused", tone: ui.warn },
};

export function QuotaCard({ q }: { q: QuotaWindow }) {
  const pace = PACE[q.pace];
  return (
    <article className={`${ui.card} ${s.card}`}>
      <div className={s.top}>
        <div>
          <h2 className="t-heading">{q.provider}</h2>
          <p className={`t-label ${s.window}`}>{q.window}</p>
        </div>
        <span className={`t-label ${ui.pill} ${pace.tone}`}>{pace.word}</span>
      </div>
      <div className={s.figure}>
        <span className="t-figure">{q.usedPercent}%</span>
        <span className={s.used}>used</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot draw the steady-pace mark */}
      <div
        className={s.bar}
        role="meter"
        aria-label={`${q.provider} ${q.window} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={q.usedPercent}
      >
        <span className={`${s.fill} ${s[q.pace]}`} style={{ width: `${q.usedPercent}%` }} />
        <span
          className={s.expected}
          style={{ left: `${q.expectedPercent}%` }}
          title={`A steady pace would be at ${q.expectedPercent}%`}
        />
      </div>
      <p className={`t-small ${s.facts}`}>
        <span>Resets {relative(q.resetsAt)}</span>
        <span>Steady pace: {q.expectedPercent}%</span>
      </p>
      {q.alert && (
        <p className={`${s.alert} ${q.pace === "unused" ? s.alertWarn : s.alertBad}`} role="status">
          {q.alert}
        </p>
      )}
    </article>
  );
}
