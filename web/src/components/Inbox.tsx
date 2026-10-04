"use client";

import { AnsweredDecision, OpenDecision } from "./DecisionCard";
import { useDecisions } from "./DecisionsProvider";
import ui from "./ui.module.css";

export function Inbox() {
  const { items, answer } = useDecisions();
  const open = items.filter((d) => !d.answer);
  const answered = items
    .filter((d) => d.answer)
    .sort((a, b) => b.answer!.at.localeCompare(a.answer!.at));

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Inbox</h1>
        {open.length > 0 && <span className={`t-label ${ui.pill} ${ui.beacon}`}>{open.length} open</span>}
      </header>
      {open.length ? (
        <ul className={ui.list}>
          {open.map((d) => (
            <li key={d.id}>
              <OpenDecision d={d} onAnswer={(v) => answer(d.id, v)} />
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
            {answered.map((d) => (
              <li key={d.id}>
                <AnsweredDecision d={d} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
