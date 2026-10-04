import { relative } from "@/lib/format";
import type { QuotaAlert, QuotaCardData, QuotaWindow } from "@/lib/types";
import s from "./QuotaCard.module.css";
import ui from "./ui.module.css";

type State = "ok" | "unused" | "out" | "unknown";

// A tone always comes with a word (DESIGN.md).
const WORD: Record<State, string> = {
  ok: "On pace",
  out: "Will run out",
  unused: "Headroom unused",
  unknown: "Too early to tell",
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
  const used = Math.round(w.usedPercent);
  const expected = w.pace ? Math.round(w.pace.expectedUsedPercent) : null;
  const fill = Math.min(Math.max(used, 0), 100);
  return (
    <article className={`${ui.card} ${s.card}`}>
      <div className={s.top}>
        <h2 className={`t-action ${s.name}`}>
          {provider} <span className={`t-small ${s.window}`}>{w.label}</span>
          {q.machine && <span className={`t-machine ${s.machine}`}>{q.machine}</span>}
        </h2>
        <span className="t-figure">
          {used}
          <span className={s.percent}>%</span>
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> cannot draw the steady-pace mark */}
      <div
        className={s.bar}
        role="meter"
        aria-label={`${provider} ${w.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${used}% used${expected !== null ? `, steady pace ${expected}%` : ""}`}
      >
        {/* A filled part, a gap, the rest of the track with a stop mark at its end. */}
        {used > 0 && <span className={`${s.fill} ${s[state]}`} style={{ flexBasis: `${fill}%` }} />}
        {fill < 100 && <span className={s.rest} />}
        {expected !== null && (
          <span
            className={s.expected}
            style={{ left: `${Math.min(expected, 100)}%` }}
            title={`A steady pace would be at ${expected}%`}
          />
        )}
      </div>
      <p className={`t-small ${s.facts}`}>
        <span className={`t-label ${s.word} ${s[state]}`}>{WORD[state]}</span>
        <span>{w.resetsAt ? `Resets ${relative(w.resetsAt)}` : "Reset time unknown"}</span>
      </p>
      {alert && (
        <p className={`t-small ${s.alert}`} role="status">
          {alertText(alert)}
        </p>
      )}
    </article>
  );
}
