"use client";

import { useEffect, useState } from "react";
import { imageSrc } from "@/lib/attachments";
import { ago, type Entry, type MachineKind, middle, type Past, timer } from "@/lib/feed";
import { closedAt } from "@/lib/outcome";
import { duration, progressText, runState } from "@/lib/runs";
import type { Decision, InboxItem, PromptItem, RunItem, Source } from "@/lib/types";
import s from "./Feed.module.css";
import { Icon, Play } from "./icons";
import { ordered } from "./options";

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

/** Facts Starbridge knows: the machine's kind and name, the repo, the time on the right. */
export function MetaRow({
  machine,
  kind,
  repo,
  time,
  size = "dense",
}: {
  machine: string;
  kind?: MachineKind;
  repo: string;
  time: string;
  size?: "dense" | "comfy";
}) {
  return (
    <div className={`${size === "dense" ? "t-meta" : "t-small"} ${s.meta}`}>
      <Icon name={machineIcon(kind)} size={size === "dense" ? 16 : 17} />
      <span>{machine}</span>
      {repo && (
        <>
          <span aria-hidden="true">·</span>
          <span className={s.repo}>{repo}</span>
        </>
      )}
      <span className={s.time}>{time}</span>
    </div>
  );
}

/** A terminal for a permission prompt, in amber because it blocks; a speech bubble for a question. */
export function KindTile({ type, size = 32 }: { type: "prompt" | "question"; size?: number }) {
  return (
    <span
      className={`${s.tile} ${type === "prompt" ? s.tilePrompt : s.tileQuestion}`}
      style={{ width: size, height: size }}
    >
      <Icon name={type === "prompt" ? "term" : "ask"} size={Math.round(size * 0.56)} />
    </span>
  );
}

export function WaitTag({ since, now, comfy }: { since: string; now: number; comfy?: boolean }) {
  return (
    <span className={`${comfy ? "t-small" : "t-meta"} ${s.wait}`}>
      <Icon name="waiting" size={comfy ? 16 : 15} />
      Waiting for you {timer(since, now)}
    </span>
  );
}

/** Whether the agent works on other things meanwhile, or waits on this question (#122). */
export function StateLine({ item, now, comfy }: { item: InboxItem; now: number; comfy?: boolean }) {
  if (item.waitingSince) return <WaitTag since={item.waitingSince} now={now} comfy={comfy} />;
  return (
    <span className={`${comfy ? "t-small" : "t-meta"} ${s.working}`}>
      <Icon name="working" size={comfy ? 16 : 15} />
      Working on other things
    </span>
  );
}

/** "Claude" or "Codex", for "Open in". */
export function agentName(agent?: string): string {
  return agent === "codex" ? "Codex" : "Claude";
}

/** The session's name, cut in the middle, and where to open it (DESIGN.md, "Rules"). */
export function SessionLine({ source, agent }: { source: Source; agent?: string }) {
  const name = source.sessionTitle || source.session;
  const links = source.links ?? [];
  const link = links.find((l) => l.kind !== "desktop") ?? links[0];
  if (!name && !link) return null;
  return (
    <div className={`t-meta ${s.session}`}>
      {name && (
        <span className={s.sessionName} title={name}>
          Session <span className="t-snippet">{middle(name, 26)}</span>
        </span>
      )}
      {link && (
        <a
          className={s.open}
          href={link.url}
          {...(link.kind === "desktop" ? {} : { target: "_blank", rel: "noopener noreferrer" })}
        >
          Open in {agentName(agent)}
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
          style={{ width, height: Math.round(width * 0.62) }}
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
};

/** One prompt or question in the feed; the whole row selects it. */
export function NeedRow({ entry, now, selected, comfy, onSelect, actions }: RowProps) {
  const type = entry.type === "prompt" ? "prompt" : "question";
  return (
    <div
      className={`${s.row} ${comfy ? s.comfy : ""}`}
      aria-current={selected ? "true" : undefined}
    >
      <button
        type="button"
        className={s.hit}
        data-id={entry.id}
        aria-label={label(entry)}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
      />
      <KindTile type={type} size={comfy ? 36 : 32} />
      <div className={s.body}>
        <MetaRow
          machine={entry.machine}
          kind={entry.kind}
          repo={entry.repo}
          time={ago(entry.at, now)}
          size={comfy ? "comfy" : "dense"}
        />
        {entry.type === "prompt" ? (
          <PromptBody p={entry.item} now={now} comfy={comfy} />
        ) : entry.type === "question" ? (
          <>
            <div className={comfy ? "t-action" : "t-label"}>{entry.item.decision.question}</div>
            <Thumbs d={entry.item.decision} width={comfy ? 140 : 112} />
            <StateLine item={entry.item} now={now} comfy={comfy} />
          </>
        ) : null}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </div>
  );
}

function PromptBody({ p, now, comfy }: { p: PromptItem; now: number; comfy?: boolean }) {
  return (
    <>
      <div className={`${comfy ? "t-small" : "t-meta"} ${s.tool}`}>
        <span className={s.toolName}>{p.permission.tool}</span>
        <WaitTag since={p.permission.createdAt} now={now} comfy={comfy} />
      </div>
      <pre className={`${comfy ? "t-code" : "t-snippet"} ${s.cmd}`}>{p.permission.summary}</pre>
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
  return { text: `No news for ${duration(now - Date.parse(r.at))}`, tone: s.dim };
}

/** A command an agent runs under `starbridge run`: what, why, and how far along. */
export function RunRow({ item, now, comfy }: { item: RunItem; now: number; comfy?: boolean }) {
  const r = item.run;
  const state = runState(r, now);
  const p = r.progress;
  const fill = p ? Math.round((p.done / p.total) * 100) : 0;
  const end = state === "running" ? now : Date.parse(r.exit?.at ?? r.at);
  return (
    <article className={`${s.run} ${comfy ? s.comfy : ""}`} aria-label={r.title}>
      <MetaRow
        machine={item.machine}
        kind={(r.source as { machineKind?: MachineKind }).machineKind}
        repo={r.source.project}
        time={timer(r.startedAt, end)}
        size={comfy ? "comfy" : "dense"}
      />
      <div className={`${comfy ? "t-action" : "t-label"} ${s.runTitle}`}>
        <Play size={12} />
        {r.title}
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

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
      <Icon name={open ? "down" : "chev"} size={16} className={s.chev} />
    </button>
  );
}

/** One answered item: the meta row, the question or command, the answer and who gave it. */
export function PastRow({
  past,
  by,
  selected,
  onSelect,
}: {
  past: Past;
  by: string;
  selected?: boolean;
  onSelect: () => void;
}) {
  const e = past.entry;
  return (
    <div className={`${s.row} ${s.past}`} aria-current={selected ? "true" : undefined}>
      <button
        type="button"
        className={s.hit}
        data-id={e.id}
        aria-label={past.text}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
      />
      <KindTile type={e.type === "prompt" ? "prompt" : "question"} />
      <div className={s.pastBody}>
        <MetaRow machine={e.machine} kind={e.kind} repo={e.repo} time={clockTime(past.closed)} />
        <div className={`${e.type === "prompt" ? "t-snippet" : "t-small"} ${s.pastText}`}>
          {past.text}
        </div>
        <div className={`t-meta ${s.dim}`}>
          {past.outcome} · {by}
        </div>
      </div>
    </div>
  );
}

/** Whether a question is closed, so the detail shows its answer instead of its options. */
export const isClosed = (item: InboxItem, now: number) => !!closedAt(item, new Date(now));

export { ordered };
