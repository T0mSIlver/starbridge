"use client";

import { useEffect, useRef, useState } from "react";
import { relative, sessionName } from "@/lib/format";
import type { Decision, InboxItem, Reply } from "@/lib/types";
import { Images, Links } from "./Attachments";
import { Context } from "./Context";
import s from "./DecisionCard.module.css";
import ui from "./ui.module.css";

/** Recommended first (SPEC.md, "Decisions as notifications"). */
export function ordered(d: Decision): string[] {
  return d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
}

// A row of up to 3 short options fits a 320px card; anything longer stacks.
// Each button's padding costs about 4 characters.
const fitsRow = (options: string[]) =>
  options.length <= 3 && options.reduce((n, o) => n + o.length + 4, 0) <= 30;

function Source({ d }: { d: Decision }) {
  return (
    <p className={`t-machine ${s.source}`}>
      {d.source.machine} · {d.source.project}
      {(d.source.session || d.source.sessionTitle) && (
        <>
          {" · "}
          <span title={d.source.session || undefined}>{sessionName(d.source)}</span>
        </>
      )}
    </p>
  );
}

const LINK_LABEL = {
  "remote-control": "Open session",
  web: "Open session",
  desktop: "Open in Desktop",
} as const;

/** Where the session that asked can be opened: claude.ai/code, or Claude Desktop. */
function SessionLinks({ d }: { d: Decision }) {
  const links = d.source.links ?? [];
  if (links.length === 0) return null;
  return (
    <nav className={s.links} aria-label="Session">
      {links.map((l) => (
        <a
          key={l.url}
          className={`${ui.button} ${l.kind === "desktop" ? s.desktopOnly : ""}`}
          href={l.url}
          {...(l.kind === "desktop" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        >
          {LINK_LABEL[l.kind]}
        </a>
      ))}
    </nav>
  );
}

const answerText = (item: InboxItem) =>
  // Answers are sealed to the asking machine: only the device that sent one can show it.
  item.reply ? ("choice" in item.reply ? item.reply.choice : item.reply.text) : "Answered";

const answeredBy = (item: InboxItem) =>
  `${item.reply ? "This browser" : "Another device"} · ${relative(item.answeredAt ?? "")}`;

export function OpenDecision({
  d,
  onAnswer,
  keys = false,
}: {
  d: Decision;
  onAnswer: (reply: Reply) => Promise<void>;
  /** Answer with keys 1 to 4, for the decision shown in the detail pane. */
  keys?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const sendingRef = useRef(false);
  const send = async (reply: Reply) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const options = ordered(d);
  const latest = useRef({ send, options });
  latest.current = { send, options };
  const hasOptions = options.length > 0;

  useEffect(() => {
    if (!keys || !hasOptions) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const choice = latest.current.options[Number(e.key) - 1];
      if (/^[1-4]$/.test(e.key) && choice) {
        e.preventDefault();
        latest.current.send({ choice });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, hasOptions]);

  return (
    <article className={`${ui.card} ${s.open}`}>
      <div className={s.meta}>
        <span className={ui.dot} aria-hidden="true" />
        <Source d={d} />
        <span className={`t-small ${s.when}`}>{relative(d.createdAt)}</span>
      </div>
      <h2 className={`t-question ${s.question}`}>{d.question}</h2>
      <Context text={d.context} className={`t-body ${s.context}`} />
      <Images d={d} />
      <Links d={d} />
      {options.length > 0 ? (
        <fieldset className={`${s.group} ${fitsRow(options) ? s.row : s.stack}`}>
          <legend className="sr-only">Answer</legend>
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`${s.option} ${o === d.recommended ? s.recommended : ""}`}
              disabled={sending}
              aria-keyshortcuts={keys && i < 4 ? String(i + 1) : undefined}
              onClick={() => send({ choice: o })}
            >
              {o}
              {o === d.recommended && <span className="sr-only">, recommended</span>}
            </button>
          ))}
        </fieldset>
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
        If nobody answers: <b>{d.default.action}</b>
        {d.default.at ? ` ${relative(d.default.at)}` : ""}.
      </p>
      <SessionLinks d={d} />
    </article>
  );
}

/** One line: the answer, the question, which device answered and when (DESIGN.md). */
export function AnsweredLine({ item }: { item: InboxItem }) {
  if (!item.answeredAt) return null;
  return (
    <div className={`t-small ${s.line}`}>
      <b className={s.lineAnswer}>{answerText(item)}</b>
      <span className={s.lineQ}>{item.decision.question}</span>
      <span className={s.lineBy}>{answeredBy(item)}</span>
    </div>
  );
}

/** An answered decision in the detail pane. */
export function AnsweredDecision({ item }: { item: InboxItem }) {
  const { decision: d, answeredAt } = item;
  if (!answeredAt) return null;
  return (
    <article className={`${ui.card} ${s.open}`}>
      <div className={s.meta}>
        <Source d={d} />
        <span className={`t-small ${s.when}`}>{relative(d.createdAt)}</span>
      </div>
      <h2 className={`t-question ${s.question}`}>{d.question}</h2>
      <Context text={d.context} className={`t-body ${s.context}`} />
      <Images d={d} />
      <Links d={d} />
      <p className={s.answer}>
        <b>{answerText(item)}</b>
        <span className="t-small">{answeredBy(item)}</span>
      </p>
      <SessionLinks d={d} />
    </article>
  );
}
