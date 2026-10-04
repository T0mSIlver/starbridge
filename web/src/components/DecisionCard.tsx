"use client";

import { useState } from "react";
import { relative } from "@/lib/format";
import type { Decision, InboxItem } from "@/lib/types";
import { Context } from "./Context";
import s from "./DecisionCard.module.css";
import type { Reply } from "./DecisionsProvider";
import ui from "./ui.module.css";

function Source({ d }: { d: Decision }) {
  return (
    <p className={`t-machine ${s.source}`}>
      {d.source.machine} · {d.source.project} · {d.source.session}
    </p>
  );
}

export function OpenDecision({ d, onAnswer }: { d: Decision; onAnswer: (reply: Reply) => void }) {
  const [text, setText] = useState("");
  // Recommended first (SPEC.md, "Decisions as notifications").
  const options = d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
  return (
    <article className={`${ui.card} ${s.open}`}>
      <div className={s.meta}>
        <Source d={d} />
        <span className="t-small">{relative(d.createdAt)}</span>
      </div>
      <h2 className={`t-question ${s.question}`}>{d.question}</h2>
      <Context text={d.context} className={s.context} />
      {options.length > 0 ? (
        <div className={s.options}>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className={`${ui.button} ${o === d.recommended ? ui.primary : ""}`}
              onClick={() => onAnswer({ choice: o })}
            >
              {o}
              {o === d.recommended && <span className={`t-label ${s.rec}`}>Recommended</span>}
            </button>
          ))}
        </div>
      ) : (
        <form
          className={s.free}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer({ text: text.trim() });
          }}
        >
          <label className="t-label" htmlFor={`answer-${d.id}`}>
            Your answer
          </label>
          <textarea
            id={`answer-${d.id}`}
            className={s.input}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className={`${ui.button} ${ui.primary}`} disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
      <p className={`t-small ${s.default}`}>
        If nobody answers: {d.default.action}
        {d.default.at ? ` ${relative(d.default.at)}` : ""}.
      </p>
    </article>
  );
}

export function AnsweredDecision({ item }: { item: InboxItem }) {
  const { decision: d, answer: a } = item;
  if (!a) return null;
  return (
    <article className={`${ui.card} ${s.answered}`}>
      <Source d={d} />
      <h3 className={s.answeredQ}>{d.question}</h3>
      <p className={s.answer}>
        <span className={s.check} aria-hidden="true">
          ✓
        </span>
        {a.choice ?? a.text}
      </p>
      <p className="t-small">
        {item.answeredBy ? `${item.answeredBy} · ` : ""}
        {relative(a.answeredAt)}
      </p>
    </article>
  );
}
