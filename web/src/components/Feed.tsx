"use client";

import { useEffect, useState } from "react";
import { imageSrc } from "@/lib/attachments";
import { ago, type Entry, type MachineKind, type Past, timer } from "@/lib/feed";
import { useFind } from "@/lib/find";
import { clockTime } from "@/lib/format";
import { fitsRow, fullInput } from "@/lib/permissionInput";
import type { Prefs } from "@/lib/prefs";
import { duration, progressText, runState } from "@/lib/runs";
import { snoozeTime } from "@/lib/snooze";
import type { Decision, PromptItem, RunItem, Source } from "@/lib/types";
import s from "./Feed.module.css";
import { Icon, Play } from "./icons";

/** The clock, ticking every `ms` while `live`. */
export function useNow(live: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [live, ms]);
  return now;
}

/** A machine's icon by its kind; a generic computer while its machine does not say (#122). */
export const machineIcon = (kind?: MachineKind) => kind ?? "desktop";

const literal = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with the Find query's words marked, bold on `surface2`: never amber, which means "needs you". */
export function Hit({ text }: { text: string }) {
  const words = useFind().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || !text) return text;
  const parts = text.split(new RegExp(`(${words.map(literal).join("|")})`, "gi"));
  return parts.map((part, i) =>
    i % 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one string, in order
      <mark key={i} className={s.match}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/**
 * Facts Starbridge knows: the machine's kind and name, the repo, the time on the right. While an
 * agent waits on the item, the time is how long it has waited, in amber (#191).
 */
export function MetaRow({
  machine,
  kind,
  repo,
  time,
  waiting,
  size = "dense",
}: {
  machine: string;
  kind?: MachineKind;
  repo: string;
  time: string;
  waiting?: boolean;
  size?: "dense" | "comfy";
}) {
  return (
    <div className={`${size === "dense" ? "t-meta" : "t-small"} ${s.meta}`}>
      <Icon name={machineIcon(kind)} size={size === "dense" ? 16 : 17} />
      <span className={s.machine}>
        <Hit text={machine} />
      </span>
      {repo && (
        <>
          <span aria-hidden="true">·</span>
          <span className={s.repo}>
            <Hit text={repo} />
          </span>
        </>
      )}
      <span className={`${s.time} ${waiting ? s.waitTime : ""}`}>{time}</span>
    </div>
  );
}

/**
 * A terminal for a permission prompt, a speech bubble for a question, straight on its card: amber
 * while its agent waits on it, `fg2` while it works around it (#248).
 */
export function KindTile({
  type,
  filled,
  size = 32,
  inline,
}: {
  type: "prompt" | "question";
  filled: boolean;
  size?: number;
  /** Before a line of text, as on Android: the glyph alone, centred on the first line. */
  inline?: boolean;
}) {
  const glyph = inline ? size : Math.round(size * 0.56);
  return (
    <span
      className={`${s.tile} ${inline ? s.tileInline : ""} ${filled ? s.tileFilled : s.tileHollow}`}
      style={inline ? undefined : { width: size, height: size }}
    >
      <Icon name={type === "prompt" ? "term" : "ask"} size={glyph} />
    </span>
  );
}

/** When the item's agent started waiting on it: a prompt always, a question once marked. */
export function waitingSince(e: Entry): string | undefined {
  if (e.type === "prompt") return e.item.permission.createdAt;
  if (e.type === "question") return e.item.waitingSince;
  return undefined;
}

/** The time slot: how long the agent has waited, else how long ago the item came. */
export function slotTime(at: string, since: string | undefined, now: number): string {
  return since ? timer(since, now) : ago(at, now);
}

/**
 * "Claude" or "Codex", for "Open in": older machines send no agent and run Claude Code. An agent
 * this page does not know gets no "Open in".
 */
export function agentName(agent?: string): string | undefined {
  if (agent === undefined || agent === "claude-code") return "Claude";
  return agent === "codex" ? "Codex" : undefined;
}

/** Characters of a session's name kept after the cut. */
const TAIL = 12;

/** The session's name, cut in the middle, and where to open it (DESIGN.md, "Rules"). */
export function SessionLine({ source, agent }: { source: Source; agent?: string }) {
  const name = source.sessionTitle || source.session;
  const links = source.links ?? [];
  const app = agentName(agent);
  const link = app ? (links.find((l) => l.kind !== "desktop") ?? links[0]) : undefined;
  if (!name && !link) return null;
  return (
    <div className={`t-meta ${s.session}`}>
      {name && (
        <span className={s.sessionName} title={name}>
          Session
          {/* Cut in the middle only when the line runs out of room: the head shrinks, the tail
              stays (#172). */}
          <span className={`t-snippet ${s.sessionHead}`}>{name.slice(0, -TAIL)}</span>
          <span className={`t-snippet ${s.sessionTail}`}>{name.slice(-TAIL)}</span>
        </span>
      )}
      {link && (
        <a
          className={s.open}
          href={link.url}
          {...(link.kind === "desktop" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        >
          Open in {app}
        </a>
      )}
    </div>
  );
}

export function Thumbs({ d, width }: { d: Decision; width: number }) {
  const images = (d.images ?? []).slice(0, 2);
  if (images.length === 0) return null;
  return (
    <div className={s.thumbs}>
      {images.map((img, i) => (
        // biome-ignore lint/performance/noImgElement: decrypted data, nothing for next/image to fetch
        <img
          // biome-ignore lint/suspicious/noArrayIndexKey: images have no id, and never reorder
          key={i}
          src={imageSrc(img)}
          alt={img.alt ?? ""}
          style={{ flexBasis: width }}
        />
      ))}
    </div>
  );
}

type RowProps = {
  entry: Entry;
  now: number;
  selected?: boolean;
  comfy?: boolean;
  onSelect: () => void;
  /** Phones answer on the row: a question's options, a prompt's Allow and Deny. */
  actions?: React.ReactNode;
  /** Under Snoozed: when it comes back, in the time slot, and nothing amber (#571). */
  until?: string;
  clock?: Prefs["clock"];
};

/** One prompt or question in the feed; the whole row selects it. */
export function NeedRow({
  entry,
  now,
  selected,
  comfy,
  onSelect,
  actions,
  until,
  clock,
}: RowProps) {
  const type = entry.type === "prompt" ? "prompt" : "question";
  const since = until ? undefined : waitingSince(entry);
  const back = until && `Until ${snoozeTime(new Date(until), new Date(now), clock)}`;
  const waited = back
    ? `Snoozed ${back.toLowerCase()}. `
    : since
      ? `Waiting for you, ${duration(now - Date.parse(since))}. `
      : "";
  return (
    <div
      className={`${s.row} ${comfy ? s.comfy : ""} ${since ? s.blocks : ""}`}
      aria-current={selected ? "true" : undefined}
      data-row={entry.id}
    >
      <button
        type="button"
        className={s.hit}
        data-id={entry.id}
        aria-label={waited + label(entry)}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
      />
      <div className={s.body}>
        <MetaRow
          machine={entry.machine}
          kind={entry.kind}
          repo={entry.repo}
          time={back || slotTime(entry.at, since, now)}
          waiting={!!since}
          size={comfy ? "comfy" : "dense"}
        />
        {entry.type === "prompt" ? (
          <PromptBody p={entry.item} comfy={comfy} filled={!!since} />
        ) : entry.type === "question" ? (
          <>
            <div className={`${comfy ? "t-action" : "t-label"} ${s.question} ${s.titled}`}>
              <KindTile type={type} filled={!!since} size={comfy ? 20 : 18} inline />
              <span>
                <Hit text={entry.item.decision.question} />
              </span>
            </div>
            <Thumbs d={entry.item.decision} width={comfy ? 140 : 112} />
          </>
        ) : null}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </div>
  );
}

function PromptBody({ p, comfy, filled }: { p: PromptItem; comfy?: boolean; filled: boolean }) {
  return (
    <>
      <div className={`${comfy ? "t-small" : "t-meta"} ${s.tool}`}>
        <KindTile type="prompt" filled={filled} size={comfy ? 20 : 18} inline />
        <span className={s.toolName}>
          <Hit text={p.permission.tool} />
        </span>
      </div>
      {/* A phone's row carries Allow when the input fits it: then it shows the input whole. */}
      {comfy && fitsRow(p.permission) ? (
        <pre className={`t-code ${s.cmd} ${s.cmdWhole}`}>
          <Hit text={fullInput(p.permission)} />
        </pre>
      ) : (
        <pre className={`${comfy ? "t-code" : "t-snippet"} ${s.cmd}`}>
          <Hit text={p.permission.summary} />
        </pre>
      )}
    </>
  );
}

const label = (e: Entry) =>
  e.type === "prompt"
    ? `${e.item.permission.tool}: ${e.item.permission.summary}`
    : e.type === "question"
      ? e.item.decision.question
      : e.item.run.title;

function runOutcome(r: RunItem["run"], now: number): { text: string; tone: string } {
  const state = runState(r, now);
  const took = duration(Date.parse(r.exit?.at ?? r.at) - Date.parse(r.startedAt));
  if (state === "passed") return { text: `Passed in ${took}`, tone: s.ok };
  if (state === "failed")
    return { text: `Failed, exit ${r.exit?.code}, after ${took}`, tone: s.bad };
  return { text: `Lost, no news for ${duration(now - Date.parse(r.at))}`, tone: s.dim };
}

/** A command an agent runs under `starbridge run`: what, why, and how far along. */
export function RunRow({ item, now, comfy }: { item: RunItem; now: number; comfy?: boolean }) {
  const r = item.run;
  const state = runState(r, now);
  const p = r.progress;
  const fill = p ? Math.round((p.done / p.total) * 100) : 0;
  const end = state === "running" ? now : Date.parse(r.exit?.at ?? r.at);
  return (
    <article className={`${s.run} ${comfy ? s.comfy : ""}`} aria-label={r.title} data-row={r.id}>
      <MetaRow
        machine={item.machine}
        kind={(r.source as { machineKind?: MachineKind }).machineKind}
        repo={r.source.project}
        // A lost run's length is unknown: its last news may predate most of it (#190).
        time={state === "lost" ? "" : timer(r.startedAt, end)}
        size={comfy ? "comfy" : "dense"}
      />
      <div className={`${comfy ? "t-action" : "t-label"} ${s.runTitle}`}>
        <Play size={12} />
        <Hit text={r.title} />
      </div>
      <div className={`t-meta ${s.dim}`}>{r.reason}</div>
      {state === "running" ? (
        <div className={s.progress}>
          <div
            className={s.progressTrack}
            role="progressbar"
            aria-label={`${r.title} progress`}
            {...(p
              ? { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": fill }
              : { "aria-busy": true })}
          >
            {p ? (
              <span className={s.progressFill} style={{ width: `${fill}%` }} />
            ) : (
              <span className={s.indeterminate} />
            )}
          </div>
          {p && (
            <span className={`t-caption ${s.dim}`}>
              {p.unit === "percent" ? progressText(p) : `${p.done} of ${p.total}`}
            </span>
          )}
        </div>
      ) : (
        <div className={`t-meta ${s.outcome} ${runOutcome(r, now).tone}`}>
          {runOutcome(r, now).text}
        </div>
      )}
    </article>
  );
}

/** History's head: collapsed by default, its state remembered on this device. */
export function HistoryHead({
  open,
  count,
  comfy,
  onToggle,
}: {
  open: boolean;
  count: number;
  comfy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`${comfy ? "t-small" : "t-meta"} ${s.historyHead} ${comfy ? s.comfy : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name="history" size={16} />
      <span className={s.historyTitle}>History</span>
      <span>{count} answered today</span>
      <Icon name="chev" size={16} className={s.chev} />
    </button>
  );
}

/** Snoozed's head (#571): collapsed by default, its state remembered on this device. */
export function SnoozedHead({
  open,
  count,
  comfy,
  onToggle,
}: {
  open: boolean;
  count: number;
  comfy?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`${comfy ? "t-small" : "t-meta"} ${s.historyHead} ${comfy ? s.comfy : ""}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Icon name="snooze" size={16} />
      <span className={s.historyTitle}>Snoozed</span>
      <span>{count}</span>
      <Icon name="chev" size={16} className={s.chev} />
    </button>
  );
}

/** One answered item: the meta row, the question or command, the answer and who gave it. */
export function PastRow({
  past,
  comfy,
  selected,
  onSelect,
}: {
  past: Past;
  comfy?: boolean;
  selected?: boolean;
  onSelect: () => void;
}) {
  const e = past.entry;
  return (
    <div
      className={`${s.row} ${s.past} ${comfy ? s.comfy : ""}`}
      aria-current={selected ? "true" : undefined}
    >
      <button
        type="button"
        className={s.hit}
        data-id={e.id}
        aria-label={past.text}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
      />
      <div className={s.pastBody}>
        <MetaRow
          machine={e.machine}
          kind={e.kind}
          repo={e.repo}
          time={clockTime(new Date(past.closed))}
        />
        <div className={`${e.type === "prompt" ? "t-snippet" : "t-small"} ${s.titled}`}>
          <KindTile
            type={e.type === "prompt" ? "prompt" : "question"}
            filled={false}
            size={comfy ? 18 : 16}
            inline
          />
          <span className={s.pastText}>
            <Hit text={past.text} />
          </span>
        </div>
        <div className={`t-meta ${s.dim}`}>
          <Hit text={past.outcome} />
          {past.by && (
            <>
              {" · "}
              <Hit text={past.by} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
