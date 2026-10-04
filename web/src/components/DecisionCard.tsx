"use client";

import { useState } from "react";
import { relative } from "@/lib/format";
import type { Decision, InboxItem, Reply } from "@/lib/types";
import { Context } from "./Context";
import s from "./DecisionCard.module.css";
import ui from "./ui.module.css";

function Source({ d }: { d: Decision }) {
  return (
    <p className={`t-machine ${s.source}`}>
      {d.source.machine} · {d.source.project} · {d.source.session}
    </p>
  );
}

export function OpenDecision({
  d,
  onAnswer,
}: {
  d: Decision;
  onAnswer: (reply: Reply) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (reply: Reply) => {
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
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
              disabled={sending}
              onClick={() => send({ choice: o })}
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
            if (text.trim()) send({ text: text.trim() });
          }}
        >
          <label className="t-label" htmlFor={`answer-${d.id}`}>
            Your answer
          </label>
          <textarea
            id={`answer-${d.id}`}
            className={ui.input}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            className={`${ui.button} ${ui.primary}`}
            disabled={sending || !text.trim()}
          >
            Send
          </button>
        </form>
      )}
      {error && <p className={ui.error}>Not sent: {error}</p>}
      <p className={`t-small ${s.default}`}>
        If nobody answers: {d.default.action}
        {d.default.at ? ` ${relative(d.default.at)}` : ""}.
      </p>
    </article>
  );
}

export function AnsweredDecision({ item }: { item: InboxItem }) {
  const { decision: d, reply, answeredAt } = item;
  if (!answeredAt) return null;
  return (
    <article className={`${ui.card} ${s.answered}`}>
      <Source d={d} />
      <h3 className={s.answeredQ}>{d.question}</h3>
      <p className={s.answer}>
        <span className={s.check} aria-hidden="true">
          ✓
        </span>
        {/* Answers are sealed to the asking machine: only the device that sent one can show it. */}
        {reply ? ("choice" in reply ? reply.choice : reply.text) : "Answered on another device"}
      </p>
      <p className="t-small">
        {reply ? "This browser · " : ""}
        {relative(answeredAt)}
      </p>
    </article>
  );
}
