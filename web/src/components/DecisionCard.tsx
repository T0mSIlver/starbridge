"use client";

import { useState } from "react";
import { relative } from "@/lib/format";
import type { Decision } from "@/lib/types";
import { Linkify } from "./Linkify";
import s from "./DecisionCard.module.css";
import ui from "./ui.module.css";

function Source({ d }: { d: Decision }) {
  return (
    <p className={`t-machine ${s.source}`}>
      {d.source.machine} · {d.source.project} · {d.source.session}
    </p>
  );
}

export function OpenDecision({ d, onAnswer }: { d: Decision; onAnswer: (value: string) => void }) {
  const [text, setText] = useState("");
  // Recommended first (SPEC.md, "Decisions as notifications").
  const options = d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
  return (
    <article className={`${ui.card} ${s.open}`}>
      <div className={s.meta}>
        <Source d={d} />
        <span className="t-small">{relative(d.askedAt)}</span>
      </div>
      <h2 className={`t-question ${s.question}`}>{d.question}</h2>
      <p className={s.context}>
        <Linkify text={d.context} />
      </p>
      {options.length > 0 ? (
        <div className={s.options}>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className={`${ui.button} ${o === d.recommended ? ui.primary : ""}`}
              onClick={() => onAnswer(o)}
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
            if (text.trim()) onAnswer(text.trim());
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
        If nobody answers: {d.default.action} {relative(d.default.at)}.
      </p>
    </article>
  );
}

export function AnsweredDecision({ d }: { d: Decision }) {
  const a = d.answer!;
  return (
    <article className={`${ui.card} ${s.answered}`}>
      <Source d={d} />
      <h3 className={s.answeredQ}>{d.question}</h3>
      <p className={s.answer}>
        <span className={s.check} aria-hidden="true">
          ✓
        </span>
        {a.value}
      </p>
      <p className="t-small">
        {a.device} · {relative(a.at)}
      </p>
    </article>
  );
}
