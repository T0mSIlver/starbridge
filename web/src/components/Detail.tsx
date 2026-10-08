"use client";

import type { DecisionLink } from "@starbridge/protocol";
import { useEffect, useRef, useState } from "react";
import type { MachineKind } from "@/lib/feed";
import { AnsweredFirst, answeredFirstText, answerPlace } from "@/lib/outcome";
import { fullInput } from "@/lib/permissionInput";
import { usePref } from "@/lib/prefs";
import { isSnoozed, snoozeTime } from "@/lib/snooze";
import type { InboxItem, PromptItem, PromptReply, Reply } from "@/lib/types";
import { ImageButton, Images, Links, rows } from "./Attachments";
import { Context } from "./Context";
import s from "./Detail.module.css";
import { KindTile, MetaRow, SessionLine, slotTime } from "./Feed";
import { Icon } from "./icons";
import { ordered } from "./options";
import { SnoozeMenu } from "./Snooze";
import ui from "./ui.module.css";
import { Viewer } from "./Viewer";

const kindOf = (source: object) => (source as { machineKind?: MachineKind }).machineKind;
const agentOf = (d: object) => (d as { agent?: string }).agent;

/** Sends one answer at a time, keeping the one in flight and its error to show. */
function useSend<T>(onAnswer: (reply: T) => Promise<void>) {
  const [pending, setPending] = useState<T>();
  const sending = pending !== undefined;
  const [error, setError] = useState<string>();
  /** Another device answered first (#330): the item says with what, once the machine tells. */
  const [lost, setLost] = useState(false);
  const busy = useRef(false);
  const send = async (reply: T) => {
    if (busy.current) return;
    busy.current = true;
    setPending(reply);
    setError(undefined);
    try {
      await onAnswer(reply);
    } catch (e) {
      if (e instanceof AnsweredFirst) setLost(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  };
  return { send, sending, pending, error, lost };
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
          // Enter sends and Shift+Enter starts a new line (#562); an Enter that ends an input
          // method's composition only commits it.
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229)
              return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
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
  onSnooze,
}: {
  item: InboxItem;
  now: number;
  /** Answer with keys 1 to 4; the wide layout's selected item only. */
  keys: boolean;
  /** "Server first · on this browser · 11:02", once answered. */
  closed?: string;
  onAnswer: (reply: Reply) => Promise<void>;
  /** Puts it off until a time (#571); a time already passed brings it back. */
  onSnooze: (until: Date) => Promise<void>;
}) {
  const d = item.decision;
  const { send, sending, pending, error, lost } = useSend(onAnswer);
  // The recommended option keeps its amber while in flight only if it is the answer sent: a typed
  // reply or another option must not look like it (#821).
  const rec = (o: string, recommended: boolean) =>
    recommended && (!pending || ("choice" in pending && pending.choice === o));
  const snoozeSend = useSend(onSnooze);
  const [clock] = usePref("clock");
  const [replying, setReplying] = useState(false);
  // One image per option: each image over the option it stands for, in the agent's order.
  const paired =
    !closed && !d.answerIn && (d.images?.length ?? 0) > 1 && d.images?.length === d.options.length;
  const options = closed || d.answerIn ? [] : paired ? d.options : ordered(d);
  const snoozed = !closed && isSnoozed(item, now);
  // While snoozed, nothing is amber, even when its agent waits: the owner said not now.
  const since = closed || snoozed ? undefined : item.waitingSince;
  useKeys(keys && options.length > 0, (key) => {
    const choice = /^[1-4]$/.test(key) ? options[Number(key) - 1] : undefined;
    if (choice) send({ choice });
    return !!choice;
  });

  return (
    <article className={s.detail} aria-label="Selected item">
      <Head since={since}>
        <MetaRow
          machine={d.source.machine}
          kind={kindOf(d.source)}
          repo={d.source.project}
          time={slotTime(d.createdAt, since, now)}
          waiting={!!since}
          size="comfy"
        />
        <h2 className="t-heading">{d.question}</h2>
        {snoozed && (
          <p className={`t-small ${s.snoozed}`}>
            <Icon name="snooze" size={16} />
            Snoozed until {snoozeTime(new Date(item.snoozedUntil as string), new Date(now), clock)}
          </p>
        )}
      </Head>
      <Context text={d.context} className={`t-reading ${s.context}`} />
      {!paired && <Images d={d} />}
      <Links d={d} />
      {closed ? (
        <p className={`t-small ${s.closed}`}>{closed}</p>
      ) : d.answerIn ? (
        <div className={s.actions}>
          <AnswerElsewhere page={d.answerIn} />
        </div>
      ) : paired ? (
        <Picks
          d={d}
          keys={keys}
          sending={sending}
          rec={(o) => rec(o, o === d.recommended)}
          onPick={(choice) => send({ choice })}
        />
      ) : options.length > 0 ? (
        <fieldset className={`${s.actions} ${s.options}`}>
          <legend className="sr-only">Answer</legend>
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`t-label ${ui.btn} ${rec(o, i === 0) ? ui.rec : ""}`}
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
      {replying && <FreeText id={d.id} sending={sending} focus onSend={(t) => send({ text: t })} />}
      {!closed && (
        // Quiet, so the options stay the answer: a typed reply in place of them (#201), Done for
        // a page's answer (#539), and putting it off (#571).
        <div className={s.quiet}>
          {d.replies && options.length > 0 && !replying && (
            <button
              type="button"
              className={`t-small ${s.link} ${s.reply}`}
              onClick={() => setReplying(true)}
            >
              Reply
            </button>
          )}
          {d.answerIn && d.done && (
            <button
              type="button"
              className={`t-small ${s.link} ${s.reply}`}
              disabled={sending}
              onClick={() => send({ done: true })}
            >
              Done
            </button>
          )}
          <SnoozeMenu
            label={snoozed ? "Snooze again" : "Snooze"}
            className={`t-small ${s.link} ${s.reply}`}
            disabled={snoozeSend.sending}
            onSnooze={(until) => snoozeSend.send(until)}
          />
          {snoozed && (
            <button
              type="button"
              className={`t-small ${s.link} ${s.reply}`}
              disabled={snoozeSend.sending}
              onClick={() => snoozeSend.send(new Date())}
            >
              Back now
            </button>
          )}
        </div>
      )}
      {snoozeSend.error && (
        <p className={ui.error} role="alert">
          Not snoozed: {snoozeSend.error}
        </p>
      )}
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

/**
 * "Pick a result": each image over the option it stands for, two to a row; picking one answers.
 * Each image keeps its own shape, no wider than its button and at most `size.pick` tall, and the
 * row's images are centred on one midline, so the buttons under them line up (#536).
 */
function Picks({
  d,
  keys,
  sending,
  rec: isRec,
  onPick,
}: {
  d: InboxItem["decision"];
  keys: boolean;
  sending: boolean;
  rec: (option: string) => boolean;
  onPick: (choice: string) => void;
}) {
  const images = d.images ?? [];
  const [open, setOpen] = useState<number>();
  return (
    <fieldset className={`${s.actions} ${s.picks}`}>
      <legend className="sr-only">Answer</legend>
      {rows(images.length).map((row) => (
        <div key={row[0]} className={s.pick}>
          <div className={s.pickColumns}>
            {row.map((i) => (
              <ImageButton
                key={i}
                img={images[i]}
                className={s.pickImage}
                onOpen={() => setOpen(i)}
              />
            ))}
          </div>
          <div className={s.pickColumns}>
            {row.map((i) => {
              const o = d.options[i];
              const rec = o === d.recommended;
              return (
                <button
                  key={o}
                  type="button"
                  className={`t-label ${ui.btn} ${isRec(o) ? ui.rec : ""}`}
                  disabled={sending}
                  aria-keyshortcuts={keys && i < 4 ? String(i + 1) : undefined}
                  onClick={() => onPick(o)}
                >
                  {o}
                  {rec && <span className="sr-only"> Default</span>}
                  {keys && i < 4 && <Kbd k={String(i + 1)} />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {open !== undefined && (
        <Viewer images={images} start={open} onClose={() => setOpen(undefined)} />
      )}
    </fieldset>
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
          {/* What the agent says the call does, else the tool (#805). */}
          <h2 className="t-action">{p.description || p.tool}</h2>
        </div>
      </Head>
      {/* The whole input, never the capped summary: Allow covers all of it (#274). */}
      <pre className={`t-command ${s.command}`}>{fullInput(p)}</pre>
      <span ref={end} aria-hidden="true" />
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
