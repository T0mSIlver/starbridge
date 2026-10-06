"use client";

import type { DecisionLink } from "@starbridge/protocol";
import { useEffect, useRef, useState } from "react";
import type { MachineKind } from "@/lib/feed";
import { AnsweredFirst, answeredFirstText, answerPlace } from "@/lib/outcome";
import { fullInput } from "@/lib/permissionInput";
import type { InboxItem, PromptItem, PromptReply, Reply } from "@/lib/types";
import { Images, Links } from "./Attachments";
import { Context } from "./Context";
import s from "./Detail.module.css";
import { KindTile, MetaRow, SessionLine, slotTime } from "./Feed";
import { Icon } from "./icons";
import { ordered } from "./options";
import ui from "./ui.module.css";

const kindOf = (source: object) => (source as { machineKind?: MachineKind }).machineKind;
const agentOf = (d: object) => (d as { agent?: string }).agent;

/** Sends one answer at a time, keeping its error to show. */
function useSend<T>(onAnswer: (reply: T) => Promise<void>) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  /** Another device answered first (#330): the item says with what, once the machine tells. */
  const [lost, setLost] = useState(false);
  const busy = useRef(false);
  const send = async (reply: T) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(reply);
    } catch (e) {
      if (e instanceof AnsweredFirst) setLost(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setSending(false);
    }
  };
  return { send, sending, error, lost };
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

/** The meta row and title, on an amber ground while the agent waits on the item (#191). */
function Head({ since, children }: { since?: string; children: React.ReactNode }) {
  return <div className={`${s.head} ${since ? s.blocks : ""}`}>{children}</div>;
}

/** A typed answer: a filled text field with its send button on the field's line (#254). */
function FreeText({
  id,
  sending,
  focus,
  onSend,
}: {
  id: string;
  sending: boolean;
  focus?: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className={s.free}
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
    >
      <label className="sr-only" htmlFor={`answer-${id}`}>
        Your answer
      </label>
      <div className={s.field}>
        <textarea
          id={`answer-${id}`}
          className={`${ui.input} t-body ${s.fieldInput}`}
          rows={1}
          placeholder="Reply"
          value={text}
          // biome-ignore lint/a11y/noAutofocus: opened by the Reply button, to type at once
          autoFocus={focus}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className={s.send}
          aria-label="Send"
          title="Send"
          disabled={sending || !text.trim()}
        >
          <Icon name="send" size={20} />
        </button>
      </div>
    </form>
  );
}

/**
 * Whether `ref` has been on screen since `key` changed: inside the scrolling detail pane, the
 * observer sees the pane's clipping too.
 */
function useSeen(ref: React.RefObject<Element | null>, key: string): boolean {
  const [seen, setSeen] = useState<string>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(key);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, key]);
  return seen === key;
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
  const { send, sending, error, lost } = useSend(onAnswer);
  const [replying, setReplying] = useState(false);
  const options = closed || d.answerIn ? [] : ordered(d);
  useKeys(keys && options.length > 0, (key) => {
    const choice = /^[1-4]$/.test(key) ? options[Number(key) - 1] : undefined;
    if (choice) send({ choice });
    return !!choice;
  });

  return (
    <article className={s.detail} aria-label="Selected item">
      <Head since={closed ? undefined : item.waitingSince}>
        <MetaRow
          machine={d.source.machine}
          kind={kindOf(d.source)}
          repo={d.source.project}
          time={slotTime(d.createdAt, closed ? undefined : item.waitingSince, now)}
          waiting={!closed && !!item.waitingSince}
          size="comfy"
        />
        <h2 className="t-heading">{d.question}</h2>
      </Head>
      <Context text={d.context} className={`t-reading ${s.context}`} />
      <Images d={d} />
      <Links d={d} />
      {closed ? (
        <p className={`t-small ${s.closed}`}>{closed}</p>
      ) : d.answerIn ? (
        <>
          <div className={s.actions}>
            <AnswerElsewhere page={d.answerIn} />
          </div>
          {d.done && (
            // Quiet, as Reply: the page stays the answer, Done only says it was given there.
            <button
              type="button"
              className={`t-small ${s.link} ${s.reply}`}
              disabled={sending}
              onClick={() => send({ done: true })}
            >
              Done
            </button>
          )}
        </>
      ) : options.length > 0 ? (
        <fieldset className={`${s.actions} ${s.options}`}>
          <legend className="sr-only">Answer</legend>
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`t-label ${ui.btn} ${i === 0 ? ui.rec : ""}`}
              disabled={sending}
              aria-keyshortcuts={keys && i < 4 ? String(i + 1) : undefined}
              onClick={() => send({ choice: o })}
            >
              {o}
              {/* Seen by its place and amber; heard as "Default" (#254). */}
              {i === 0 && <span className="sr-only"> Default</span>}
              {keys && i < 4 && <Kbd k={String(i + 1)} />}
            </button>
          ))}
        </fieldset>
      ) : (
        <FreeText id={d.id} sending={sending} onSend={(t) => send({ text: t })} />
      )}
      {!closed &&
        d.replies &&
        options.length > 0 &&
        !d.answerIn &&
        // A typed reply in place of the options (#201): quiet, so the options stay the answer.
        (replying ? (
          <FreeText id={d.id} sending={sending} focus onSend={(t) => send({ text: t })} />
        ) : (
          <button
            type="button"
            className={`t-small ${s.link} ${s.reply}`}
            onClick={() => setReplying(true)}
          >
            Reply
          </button>
        ))}
      {lost && (
        <p className={ui.error} role="alert">
          {answeredFirstText(item)}
        </p>
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
  // Allow, by button, key or grant, waits until the input's end has been on screen.
  const end = useRef<HTMLSpanElement>(null);
  const seen = useSeen(end, p.id);
  const allowing = sending || !seen;
  useKeys(keys && !closed, (key) => {
    if (key === "a") {
      if (!allowing) send({ behavior: "allow", scope: "once" });
    } else if (key === "d") send({ behavior: "deny", scope: "once" });
    else return false;
    return true;
  });

  return (
    <article className={s.detail} aria-label="Selected item">
      <Head since={closed ? undefined : p.createdAt}>
        <MetaRow
          machine={p.source.machine}
          kind={kindOf(p.source)}
          repo={p.source.project}
          time={slotTime(p.createdAt, closed ? undefined : p.createdAt, now)}
          waiting={!closed}
          size="comfy"
        />
        <div className={s.toolHead}>
          <KindTile type="prompt" filled={!closed} size={28} />
          <h2 className="t-action">{p.tool}</h2>
        </div>
      </Head>
      {/* The whole input, never the capped summary: Allow covers all of it (#274). */}
      <pre className={`t-command ${s.command}`}>{fullInput(p)}</pre>
      <span ref={end} aria-hidden="true" />
      {p.description && <p className={`t-reading ${s.context}`}>{p.description}</p>}
      {closed ? (
        <p className={`t-small ${s.closed}`}>{closed}</p>
      ) : (
        <>
          <div className={s.actions}>
            <button
              type="button"
              className={`t-action ${ui.btn} ${ui.lg} ${ui.rec}`}
              disabled={allowing}
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
          {/* Each wider allow shows the exact rule it adds, not only in a tooltip (#274). */}
          {[session, project].map(
            (g) =>
              g && (
                <div key={g.scope} className={`t-small ${s.grant}`}>
                  <button
                    type="button"
                    className={s.link}
                    disabled={allowing}
                    onClick={() => send({ behavior: "allow", scope: g.scope })}
                  >
                    {g.label}
                  </button>
                  <code className={`t-snippet ${s.rule}`}>{g.rule}</code>
                </div>
              ),
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
