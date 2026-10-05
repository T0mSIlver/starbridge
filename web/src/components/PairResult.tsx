import { Icon, type IconName } from "./icons";
import p from "./Pairing.module.css";

/** How a pairing ended, in the panel that held the request. */
export interface PairOutcome {
  name: string;
  icon: IconName;
  title: string;
  sub: string;
}

export function PairResult({
  outcome,
  children,
}: {
  outcome: PairOutcome;
  children: React.ReactNode;
}) {
  return (
    <article className={p.panel} role="status" aria-label="Pairing result">
      <div className={`t-meta ${p.meta}`}>
        <Icon name={outcome.icon} size={16} />
        <span>{outcome.name}</span>
      </div>
      <div>
        <h2 className="t-action">{outcome.title}</h2>
        <p className={`t-small ${p.dim}`}>{outcome.sub}</p>
      </div>
      <div className={p.actions}>{children}</div>
    </article>
  );
}
