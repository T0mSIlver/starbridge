import { relative } from "@/lib/format";
import type { QuotaAlert, QuotaCardData, QuotaWindow } from "@/lib/types";
import s from "./QuotaCard.module.css";
import ui from "./ui.module.css";

type State = "ok" | "unused" | "out" | "unknown";

// A tone always comes with a word (DESIGN.md).
const STATE: Record<State, { word: string; tone: string }> = {
  ok: { word: "On pace", tone: ui.ok },
  out: { word: "Will run out", tone: ui.bad },
  unused: { word: "Headroom unused", tone: ui.warn },
  unknown: { word: "Too early to tell", tone: ui.muted },
};

function stateOf(w: QuotaWindow, alert?: QuotaAlert): State {
  if (!w.pace || w.pace.stage === "unknown") return "unknown";
  if (!w.pace.willLastToReset) return "out";
  if (alert?.kind === "unused-headroom") return "unused";
  return "ok";
}

function alertText(a: QuotaAlert): string {
  return a.kind === "runs-out"
    ? `Runs out ${relative(a.runsOutAt)} at this pace; resets ${relative(a.resetsAt)}.`
    : `Resets ${relative(a.resetsAt)} with ${Math.round(a.unusedPercent)}% unused.`;
}

export function QuotaCard({ q }: { q: QuotaCardData }) {
  const { provider, window: w, alert } = q;
  const state = stateOf(w, alert);
  const word = STATE[state];
  const used = Math.round(w.usedPercent);
  const expected = w.pace ? Math.round(w.pace.expectedUsedPercent) : null;
  return (
    <article className={`${ui.card} ${s.card}`}>
      <div className={s.top}>
        <div>
          <h2 className="t-heading">{provider}</h2>
          <p className={`t-label ${s.window}`}>{w.label}</p>
        </div>
        <span className={`t-label ${ui.pill} ${word.tone}`}>{word.word}</span>
      </div>
      <div className={s.figure}>
        <span className="t-figure">{used}%</span>
        <span className={s.used}>used</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot draw the steady-pace mark */}
      <div
        className={s.bar}
        role="meter"
        aria-label={`${provider} ${w.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
      >
        <span className={`${s.fill} ${s[state]}`} style={{ width: `${Math.min(used, 100)}%` }} />
        {expected !== null && (
          <span
            className={s.expected}
            style={{ left: `${Math.min(expected, 100)}%` }}
            title={`A steady pace would be at ${expected}%`}
          />
        )}
      </div>
      <p className={`t-small ${s.facts}`}>
        <span>{w.resetsAt ? `Resets ${relative(w.resetsAt)}` : "Reset time unknown"}</span>
        {expected !== null && <span>Steady pace: {expected}%</span>}
      </p>
      {alert && (
        <p
          className={`${s.alert} ${alert.kind === "runs-out" ? s.alertBad : s.alertWarn}`}
          role="status"
        >
          {alertText(alert)}
        </p>
      )}
    </article>
  );
}
