"use client";

import { AnsweredDecision, OpenDecision } from "./DecisionCard";
import { useDecisions } from "./DecisionsProvider";
import ui from "./ui.module.css";

export function Inbox() {
  const { items, answer } = useDecisions();
  const open = items.filter((item) => !item.answer);
  const answered = items
    .filter((item) => item.answer)
    .sort((a, b) => (b.answer?.answeredAt ?? "").localeCompare(a.answer?.answeredAt ?? ""));

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Inbox</h1>
        {open.length > 0 && (
          <span className={`t-label ${ui.pill} ${ui.beacon}`}>{open.length} open</span>
        )}
      </header>
      {open.length ? (
        <ul className={ui.list}>
          {open.map(({ decision: d }) => (
            <li key={d.id}>
              <OpenDecision d={d} onAnswer={(reply) => answer(d.id, reply)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className={ui.empty}>Nothing needs you.</p>
      )}
      {answered.length > 0 && (
        <>
          <h2 className={`t-label ${ui.section}`}>Answered</h2>
          <ul className={ui.list}>
            {answered.map((item) => (
              <li key={item.decision.id}>
                <AnsweredDecision item={item} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
