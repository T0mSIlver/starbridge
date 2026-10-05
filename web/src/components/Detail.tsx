"use client";

import type { DecisionLink } from "@starbridge/protocol";
import { useEffect, useRef, useState } from "react";
import { ago, type MachineKind } from "@/lib/feed";
import { answerPlace } from "@/lib/outcome";
import type { InboxItem, PromptItem, PromptReply, Reply } from "@/lib/types";
import { Images, Links } from "./Attachments";
import { Context } from "./Context";
import s from "./Detail.module.css";
import { KindTile, MetaRow, SessionLine, StateLine, WaitTag } from "./Feed";
import { ordered } from "./options";
import ui from "./ui.module.css";

const kindOf = (source: object) => (source as { machineKind?: MachineKind }).machineKind;
const agentOf = (d: object) => (d as { agent?: string }).agent;

/** Sends one answer at a time, keeping its error to show. */
function useSend<T>(onAnswer: (reply: T) => Promise<void>) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const send = async (reply: T) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(reply);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return { send, sending, error };
}

/** Keys for the selected item, ignored while typing or with a modifier. */
function useKeys(on: boolean, handler: (key: string) => boolean) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      if (latest.current(e.key.toLowerCase())) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on]);
}

const Kbd = ({ k }: { k: string }) => (
  <span className={`t-key ${ui.kbd}`} aria-hidden="true">
    {k}
  </span>
);

/** The owner answers on another page: the one action opens it, in amber. */
function AnswerElsewhere({ page }: { page: DecisionLink }) {
  return (
    <a
      className={`t-label ${ui.btn} ${ui.rec}`}
      href={page.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      Answer in {answerPlace(page)}
    </a>
  );
}

/** A question: what the agent asked, its state, its words, its options, and its session. */
export function QuestionDetail({
  item,
  now,
  keys,
  closed,
  onAnswer,
}: {
  item: InboxItem;
  now: number;
  /** Answer with keys 1 to 4; the wide layout's selected item only. */
  keys: boolean;
  /** "Server first · on this browser · 11:02", once answered. */
  closed?: string;
  onAnswer: (reply: Reply) => Promise<void>;
}) {
  const d = item.decision;
  const { send, sending, error } = useSend(onAnswer);
  const [text, setText] = useState("");
  const options = closed || d.answerIn ? [] : ordered(d);
  useKeys(keys && options.length > 0, (key) => {
    const choice = /^[1-4]$/.test(key) ? options[Number(key) - 1] : undefined;
    if (choice) send({ choice });
    return !!choice;
  });

  return (
    <article className={s.detail} aria-label="Selected item">
      <MetaRow
        machine={d.source.machine}
        kind={kindOf(d.source)}
        repo={d.source.project}
        time={ago(d.createdAt, now)}
        size="comfy"
      />
      <h2 className="t-heading">{d.question}</h2>
      {!closed && <StateLine item={item} now={now} comfy />}
      <Context text={d.context} className={`t-reading ${s.context}`} />
      <Images d={d} />
      <Links d={d} />
      {closed ? (
        <p className={`t-small ${s.closed}`}>{closed}</p>
      ) : d.answerIn ? (
        <div className={s.actions}>
          <AnswerElsewhere page={d.answerIn} />
        </div>
      ) : options.length > 0 ? (
        <fieldset className={s.actions}>
          <legend className="sr-only">Answer</legend>
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`t-label ${ui.btn} ${o === d.recommended ? ui.rec : ""}`}
              disabled={sending}
              aria-keyshortcuts={keys && i < 4 ? String(i + 1) : undefined}
              onClick={() => send({ choice: o })}
            >
              {o}
              {o === d.recommended && <span className="sr-only">, recommended</span>}
              {keys && i < 4 && <Kbd k={String(i + 1)} />}
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
          <label className="sr-only" htmlFor={`answer-${d.id}`}>
            Your answer
          </label>
          <textarea
            id={`answer-${d.id}`}
            className={`${ui.input} t-body`}
            rows={2}
            placeholder="Reply"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            type="submit"
            className={`t-label ${ui.btn} ${ui.fill}`}
            disabled={sending || !text.trim()}
          >
            Send
          </button>
        </form>
      )}
      {error && (
        <p className={ui.error} role="alert">
          Not sent: {error}
        </p>
      )}
      <SessionLine source={d.source} agent={agentOf(d)} />
    </article>
  );
}

/** A permission prompt: the agent is blocked on this command until Allow or Deny. */
export function PromptDetail({
  item,
  now,
  keys,
  closed,
  onAnswer,
}: {
  item: PromptItem;
  now: number;
  keys: boolean;
  closed?: string;
  onAnswer: (reply: PromptReply) => Promise<void>;
}) {
  const p = item.permission;
  const { send, sending, error } = useSend(onAnswer);
  const session = p.suggestions.find((x) => x.scope === "session");
  const project = p.suggestions.find((x) => x.scope === "project");
  useKeys(keys && !closed, (key) => {
    if (key === "a") send({ behavior: "allow", scope: "once" });
    else if (key === "d") send({ behavior: "deny", scope: "once" });
    else return false;
    return true;
  });

  return (
    <article className={s.detail} aria-label="Selected item">
      <MetaRow
        machine={p.source.machine}
        kind={kindOf(p.source)}
        repo={p.source.project}
        time={ago(p.createdAt, now)}
        size="comfy"
      />
      <div className={s.toolHead}>
        <KindTile type="prompt" size={28} />
        <h2 className="t-action">{p.tool}</h2>
        {!closed && (
          <span className={s.right}>
            <WaitTag since={p.createdAt} now={now} comfy />
          </span>
        )}
      </div>
      <pre className={`t-command ${s.command}`}>{p.summary}</pre>
      {p.description && <p className={`t-reading ${s.context}`}>{p.description}</p>}
      {closed ? (
        <p className={`t-small ${s.closed}`}>{closed}</p>
      ) : (
        <>
          <div className={s.actions}>
            <button
              type="button"
              className={`t-action ${ui.btn} ${ui.lg} ${ui.rec}`}
              disabled={sending}
              aria-keyshortcuts={keys ? "A" : undefined}
              onClick={() => send({ behavior: "allow", scope: "once" })}
            >
              Allow {keys && <Kbd k="A" />}
            </button>
            <button
              type="button"
              className={`t-action ${ui.btn} ${ui.lg}`}
              disabled={sending}
              aria-keyshortcuts={keys ? "D" : undefined}
              onClick={() => send({ behavior: "deny", scope: "once" })}
            >
              Deny {keys && <Kbd k="D" />}
            </button>
          </div>
          {(session || project) && (
            <div className={`t-small ${s.grants}`}>
              {session && (
                <button
                  type="button"
                  className={s.link}
                  disabled={sending}
                  title={session.rule}
                  onClick={() => send({ behavior: "allow", scope: "session" })}
                >
                  {session.label}
                </button>
              )}
              {project && (
                <button
                  type="button"
                  className={s.link}
                  disabled={sending}
                  title={project.rule}
                  onClick={() => send({ behavior: "allow", scope: "project" })}
                >
                  {project.label}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
      <SessionLine source={p.source} agent={p.agent} />
    </article>
  );
}
