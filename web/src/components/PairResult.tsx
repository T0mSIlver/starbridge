import { Icon, type IconName } from "./icons";
import p from "./Pairing.module.css";

/** How a pairing ended, in the panel that held the request. */
export interface PairOutcome {
  name: string;
  icon: IconName;
  title: string;
  sub: string;
  /** A machine's check code, for the owner to compare with its terminal (#795). */
  check?: string;
}

export function PairResult({
  outcome,
  children,
}: {
  outcome: PairOutcome;
  children: React.ReactNode;
}) {
  return (
    <article className={`m-appear ${p.panel}`} role="status" aria-label="Pairing result">
      <div className={`t-meta ${p.meta}`}>
        <Icon name={outcome.icon} size={16} />
        <span>{outcome.name}</span>
      </div>
      <div>
        <h2 className="t-action">{outcome.title}</h2>
        {outcome.check && (
          <p className="t-code" data-testid="check-code">
            Check code {outcome.check}
          </p>
        )}
        <p className={`t-small ${p.dim}`}>{outcome.sub}</p>
      </div>
      <div className={p.actions}>{children}</div>
    </article>
  );
}
