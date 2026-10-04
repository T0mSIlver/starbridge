"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { relative, sessionName } from "@/lib/format";
import type { PromptItem, PromptReply } from "@/lib/types";
import { useApp } from "./AppProvider";
import s from "./Prompts.module.css";
import ui from "./ui.module.css";

/** How long a prompt settled elsewhere stays, as "Answered on devbox", before it leaves. */
export const CLOSING_MS = 3_000;

/** The input as indented JSON, or as received when it is not JSON. */
function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** "Answered on devbox", "Timed out", "Allowed from this browser". */
export function settledText(p: PromptItem, deviceName: (id: string) => string): string {
  if (p.reply) return p.reply.behavior === "allow" ? "Allowed here" : "Denied here";
  const out = p.settled?.outcome;
  if (out === "keyboard") return `Answered on ${p.permission.source.machine}`;
  if (out === "timeout") return "Timed out: left to the keyboard";
  if (out === "device" && p.settled?.device) return `Answered from ${deviceName(p.settled.device)}`;
  return "Answered on another device";
}

/**
 * Permission prompts waiting now, above the inbox. Shown only while one is open; a prompt
 * settled anywhere else says where for a moment and leaves (DESIGN.md, SPEC.md #57).
 */
export function Prompts() {
  const { prompts, answerPrompt, deviceName } = useApp();
  const now = Date.now();
  const shown = prompts.filter(
    (p) =>
      (!p.answeredAt && Date.parse(p.permission.expiresAt) > now) ||
      (p.closedAt !== undefined && now - p.closedAt < CLOSING_MS),
  );
  if (shown.length === 0) return null;
  return (
    <section className={s.lane} aria-label="Permission prompts">
      <header className={s.head}>
        <h2 className={`t-label ${s.title}`}>
          <span className={ui.dot} aria-hidden="true" /> Prompts
        </h2>
        <Link href="/prompts" className={`t-small ${s.logLink}`}>
          Last 7 days
        </Link>
      </header>
      <ul className={ui.list}>
        {shown.map((p, i) => (
          <li key={p.permission.id}>
            {p.answeredAt ? (
              <p className={`${ui.card} t-body ${s.closed}`} role="status">
                <code className="t-code">{p.permission.summary}</code>
                <span>{settledText(p, deviceName)}</span>
              </p>
            ) : (
              <Prompt p={p} first={i === 0} onAnswer={(reply) => answerPrompt(p, reply)} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Prompt({
  p,
  first,
  onAnswer,
}: {
  p: PromptItem;
  first: boolean;
  onAnswer: (reply: PromptReply) => Promise<void>;
}) {
  const d = p.permission;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const sendingRef = useRef(false);
  const allowRef = useRef<HTMLButtonElement>(null);
  // Allow once is the default focus, on the first prompt only, so tabbing starts there.
  useEffect(() => {
    if (first) allowRef.current?.focus({ preventScroll: true });
  }, [first]);

  const send = async (reply: PromptReply) => {
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
  const session = d.suggestions.find((x) => x.scope === "session");
  const project = d.suggestions.find((x) => x.scope === "project");

  return (
    <article className={`${ui.card} ${s.prompt}`}>
      <div className={s.meta}>
        <span className={`t-label ${s.tool}`}>{d.tool}</span>
        <span className={`t-machine ${s.source}`}>
          {d.source.machine} · {d.source.project}
          {(d.source.session || d.source.sessionTitle) && (
            <>
              {" · "}
              <span title={d.source.session || undefined}>{sessionName(d.source)}</span>
            </>
          )}
        </span>
        <span className={`t-small ${s.when}`}>{relative(d.createdAt)}</span>
      </div>
      <p className={s.summary}>
        <code className="t-code">{d.summary}</code>
      </p>
      {d.description && <p className={`t-body ${s.description}`}>{d.description}</p>}
      <details className={s.details}>
        <summary className="t-small">Full input</summary>
        <pre className={`t-code ${s.input}`}>{pretty(d.input)}</pre>
      </details>
      <div className={s.actions}>
        <button
          ref={allowRef}
          type="button"
          className={`${ui.button} ${ui.beaconFill}`}
          disabled={sending}
          onClick={() => send({ behavior: "allow", scope: "once" })}
        >
          Allow once
        </button>
        {session && (
          <button
            type="button"
            className={ui.button}
            disabled={sending}
            title={`Adds ${session.rule} for the rest of the session`}
            onClick={() => send({ behavior: "allow", scope: "session" })}
          >
            {session.label}
          </button>
        )}
        {project && (
          <button
            type="button"
            className={ui.button}
            disabled={sending}
            onClick={() => send({ behavior: "allow", scope: "project" })}
          >
            {project.label}
          </button>
        )}
        <button
          type="button"
          className={`${ui.button} ${ui.danger}`}
          disabled={sending}
          aria-expanded={denying}
          onClick={() => setDenying((v) => !v)}
        >
          Deny
        </button>
      </div>
      {project && (
        <p className={`t-small ${s.rule}`}>
          Always adds <code className="t-code">{project.rule}</code> to this project's{" "}
          <code className="t-code">.claude/settings.local.json</code>.
        </p>
      )}
      {denying && (
        <form
          className={s.deny}
          onSubmit={(e) => {
            e.preventDefault();
            const text = message.trim();
            send({ behavior: "deny", scope: "once", ...(text ? { message: text } : {}) });
          }}
        >
          <div className={ui.field}>
            <label htmlFor={`deny-${d.id}`} className="t-small">
              Tell the agent what to do instead (optional)
            </label>
            <textarea
              id={`deny-${d.id}`}
              className={`${ui.input} t-body`}
              rows={2}
              maxLength={500}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>
          <button type="submit" className={`${ui.button} ${ui.danger}`} disabled={sending}>
            Send deny
          </button>
        </form>
      )}
      {error && (
        <p className={ui.error} role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** The last 7 days of prompts and who settled them where. */
export function PromptLog() {
  const { promptLog, loadPromptLog, deviceName } = useApp();
  useEffect(() => {
    loadPromptLog().catch(() => {});
  }, [loadPromptLog]);
  const rows = [...(promptLog ?? [])].sort((a, b) =>
    b.permission.createdAt.localeCompare(a.permission.createdAt),
  );
  return (
    <>
      <header className={ui.head}>
        <h1 className="t-title">Prompts</h1>
      </header>
      {promptLog === undefined ? null : rows.length === 0 ? (
        <p className={ui.empty}>No permission prompts in the last 7 days.</p>
      ) : (
        <ul className={s.log}>
          {rows.map((p) => (
            <li key={p.permission.id} className={s.logRow}>
              <code className={`t-code ${s.logSummary}`}>{p.permission.summary}</code>
              <span className={`t-small ${s.logBy}`}>
                {p.permission.tool} · {p.permission.source.machine} · {p.permission.source.project}{" "}
                · {relative(p.permission.createdAt)}
              </span>
              <span className={`t-small ${s.logOutcome}`}>
                {p.answeredAt
                  ? settledText(p, deviceName)
                  : Date.parse(p.permission.expiresAt) > Date.now()
                    ? "Waiting"
                    : "Expired"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
