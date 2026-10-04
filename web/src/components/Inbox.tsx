"use client";

import { useApp } from "./AppProvider";
import { AnsweredDecision, OpenDecision } from "./DecisionCard";
import { PushBanner } from "./PushBanner";
import ui from "./ui.module.css";

export function Inbox() {
  const { inbox, answer } = useApp();
  const open = inbox.items
    .filter((item) => !item.answeredAt)
    .sort((a, b) => b.decision.createdAt.localeCompare(a.decision.createdAt));
  const answered = inbox.items
    .filter((item) => item.answeredAt)
    .sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));

  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Inbox</h1>
        {open.length > 0 && (
          <span className={`t-label ${ui.pill} ${ui.beacon}`}>{open.length} open</span>
        )}
      </header>
      <PushBanner />
      {inbox.rejected.length > 0 && (
        <p className={ui.error} role="status">
          {inbox.rejected.length === 1 ? "One decision" : `${inbox.rejected.length} decisions`}{" "}
          failed verification and are hidden: {inbox.rejected[0]?.error}
        </p>
      )}
      {open.length ? (
        <ul className={ui.list}>
          {open.map((item) => (
            <li key={item.decision.id}>
              <OpenDecision d={item.decision} onAnswer={(reply) => answer(item, reply)} />
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
