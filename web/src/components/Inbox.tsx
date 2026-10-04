"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { relative } from "@/lib/format";
import type { InboxItem, Reply } from "@/lib/types";
import { useApp } from "./AppProvider";
import { AnsweredDecision, AnsweredLine, OpenDecision, ordered } from "./DecisionCard";
import s from "./Inbox.module.css";
import { PushBanner } from "./PushBanner";
import ui from "./ui.module.css";

// Where the side rail leaves room for a list beside the detail (Shell.module.css).
const WIDE = "(min-width: 1100px)";

function useWide(): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", change);
      return () => m.removeEventListener("change", change);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export function Inbox() {
  const { inbox, answer } = useApp();
  const wide = useWide();
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
          <span className={`t-label ${ui.count}`}>
            <span className={ui.dot} aria-hidden="true" />
            {open.length} open
          </span>
        )}
      </header>
      <PushBanner />
      {inbox.rejected.length > 0 && (
        <p className={ui.error} role="status">
          {inbox.rejected.length === 1 ? "One decision" : `${inbox.rejected.length} decisions`}{" "}
          failed verification and are hidden: {inbox.rejected[0]?.error}
        </p>
      )}
      {wide ? (
        <Panes open={open} answered={answered} answer={answer} />
      ) : (
        <>
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
              <ul className={s.log}>
                {answered.map((item) => (
                  <li key={item.decision.id}>
                    <AnsweredLine item={item} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

type Answer = ReturnType<typeof useApp>["answer"];

/** Wide screens: the list beside the selected decision, J and K to move, 1 to 4 to answer. */
function Panes({
  open,
  answered,
  answer,
}: {
  open: InboxItem[];
  answered: InboxItem[];
  answer: Answer;
}) {
  const all = [...open, ...answered];
  const [picked, setPicked] = useState<string>();
  const selected = all.find((item) => item.decision.id === picked) ?? all[0];
  // Once answered, a decision leaves the open list; the selection moves to the next open one.
  const answerSelected = async (item: InboxItem, reply: Reply) => {
    const at = open.indexOf(item);
    const next = open[at + 1] ?? open[at - 1];
    await answer(item, reply);
    setPicked(next?.decision.id);
  };

  const index = selected ? all.indexOf(selected) : -1;
  const latest = useRef({ all, index });
  latest.current = { all, index };
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const step = e.key === "j" || e.key === "J" ? 1 : e.key === "k" || e.key === "K" ? -1 : 0;
      if (!step) return;
      const { all, index } = latest.current;
      const next = all[Math.min(Math.max(index + step, 0), all.length - 1)];
      if (!next) return;
      e.preventDefault();
      setPicked(next.decision.id);
      listRef.current
        ?.querySelector(`[data-id="${CSS.escape(next.decision.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!selected) return <p className={ui.empty}>Nothing needs you.</p>;
  const options = selected.answeredAt ? [] : ordered(selected.decision);
  return (
    <div className={s.panes}>
      <ul className={s.list} ref={listRef} aria-label="Decisions">
        {all.map((item) => {
          const d = item.decision;
          const on = item === selected;
          return (
            <li key={d.id}>
              <button
                type="button"
                data-id={d.id}
                className={`${s.row} ${item.answeredAt ? s.done : ""}`}
                aria-current={on ? "true" : undefined}
                onClick={() => setPicked(d.id)}
              >
                <span className={s.rowQ}>
                  {item.answeredAt ? (
                    <span className={s.spacer} />
                  ) : (
                    <span className={`${ui.dot} ${s.rowDot}`} aria-hidden="true" />
                  )}
                  {d.question}
                </span>
                <span className={`t-small ${s.rowSub}`}>
                  {item.answeredAt
                    ? `${item.reply ? ("choice" in item.reply ? item.reply.choice : item.reply.text) : "Answered"} · ${relative(item.answeredAt)}`
                    : `${d.source.session} · ${relative(d.createdAt)}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <section className={s.detail} aria-label="Selected decision">
        {selected.answeredAt ? (
          <AnsweredDecision item={selected} />
        ) : (
          <OpenDecision
            key={selected.decision.id}
            d={selected.decision}
            keys
            onAnswer={(reply) => answerSelected(selected, reply)}
          />
        )}
        <p className={`t-small ${s.keys}`}>
          {options.length > 0 && (
            <span>
              {options.slice(0, 4).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the key number is the identity
                <kbd key={i}>{i + 1}</kbd>
              ))}{" "}
              answer
            </span>
          )}
          <span>
            <kbd>J</kbd> <kbd>K</kbd> next, previous
          </span>
        </p>
      </section>
    </div>
  );
}
