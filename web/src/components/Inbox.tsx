"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  byMachine,
  closedToday,
  type Entry,
  history,
  needsYou,
  type Past,
  promptOpen,
  running,
} from "@/lib/feed";
import { matches, useFind } from "@/lib/find";
import { closedByPhrase, promptOutcome } from "@/lib/outcome";
import { usePref } from "@/lib/prefs";
import { afterAnswer, selectedId, step } from "@/lib/selection";
import type { InboxItem, PromptItem } from "@/lib/types";
import { useApp } from "./AppProvider";
import { PromptDetail, QuestionDetail } from "./Detail";
import { HistoryHead, machineIcon, NeedRow, PastRow, RunRow, useNow } from "./Feed";
import s from "./Inbox.module.css";
import { Icon } from "./icons";
import { ordered } from "./options";
import { PhoneBar } from "./PhoneBar";
import { PushBanner } from "./PushBanner";
import { QuotaAside } from "./QuotaAside";
import ui from "./ui.module.css";

// From here the list and the detail sit side by side (Inbox.module.css).
const WIDE = "(min-width: 1100px)";

function useWide(): boolean {
  return useSyncExternalStore(
    (change) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener("change", change);
      return () => m.removeEventListener("change", change);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

const text = (e: Entry) =>
  e.type === "prompt"
    ? [e.item.permission.tool, e.item.permission.summary, e.item.permission.source.sessionTitle]
    : e.type === "question"
      ? [e.item.decision.question, e.item.decision.context, e.item.decision.source.sessionTitle]
      : [e.item.run.title, e.item.run.reason];

export function Inbox() {
  const { inbox, prompts, runs, promptLog, loadPromptLog, answer, answerPrompt, deviceName } =
    useApp();
  const [grouped, setGrouped] = usePref("groupByMachine");
  const [historyOpen, setHistoryOpen] = usePref("historyOpen");
  const find = useFind();
  const wide = useWide();
  const live =
    prompts.length > 0 || inbox.items.some((i) => i.waitingSince) || !!runs?.items.length;
  // Every second while a timer shows, else every minute so the times since stay current.
  const now = useNow(true, live ? 1000 : 60_000);

  useEffect(() => {
    if (historyOpen) loadPromptLog().catch(() => {});
  }, [historyOpen, loadPromptLog]);

  const keep = (e: Entry) => !find || matches(find, [e.machine, e.repo, ...text(e)]);
  const needs = needsYou(inbox.items, prompts, now).filter(keep);
  const runEntries = running(runs?.items ?? [], now).filter(keep);
  const allPrompts = useMemo(() => {
    const seen = new Map<string, PromptItem>();
    for (const p of [...(promptLog ?? []), ...prompts]) seen.set(p.permission.id, p);
    return [...seen.values()];
  }, [promptLog, prompts]);
  const past = history(inbox.items, allPrompts, (p) => promptOutcome(p, deviceName), now).filter(
    (p) => keep(p.entry),
  );

  const ids = [...needs, ...(historyOpen ? past.map((p) => p.entry) : [])].map((e) => e.id);
  const [picked, setPicked] = useState<string>();
  // Phones and narrow windows show the detail in place of the list once a row is tapped.
  const [opened, setOpened] = useState<string>();
  const selected = wide ? selectedId(ids, picked) : opened;
  useEffect(() => {
    if (wide && selected && picked !== selected) setPicked(selected);
  }, [wide, selected, picked]);

  const latest = useRef({ ids, selected });
  latest.current = { ids, selected };
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const by = e.key === "j" || e.key === "J" ? 1 : e.key === "k" || e.key === "K" ? -1 : 0;
      if (!by) return;
      const next = step(latest.current.ids, latest.current.selected, by);
      if (next === undefined) return;
      e.preventDefault();
      setPicked(next);
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`);
      if (list?.contains(document.activeElement)) row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide]);

  const openIds = needs.map((e) => e.id);
  const moveOn = (id: string) => {
    const next = afterAnswer(openIds, id);
    setPicked((cur) => (cur === id ? next : cur));
  };
  const answerQuestion = async (item: InboxItem, reply: Parameters<typeof answer>[1]) => {
    await answer(item, reply);
    moveOn(item.decision.id);
  };
  const answerOne = async (item: PromptItem, reply: Parameters<typeof answerPrompt>[1]) => {
    await answerPrompt(item, reply);
    moveOn(item.permission.id);
  };

  const pastOf = new Map(past.map((p) => [p.entry.id, p]));
  const entryOf = new Map(needs.map((e) => [e.id, e]));
  const detail = (id: string | undefined) => {
    if (!id) return null;
    const open = entryOf.get(id);
    const done = pastOf.get(id);
    const e = open ?? done?.entry;
    if (!e || e.type === "run") return null;
    const closed = done ? closedLine(done) : undefined;
    return e.type === "prompt" ? (
      <PromptDetail
        key={id}
        item={e.item}
        now={now}
        keys={wide}
        closed={closed}
        onAnswer={(r) => answerOne(e.item, r)}
      />
    ) : (
      <QuestionDetail
        key={id}
        item={e.item}
        now={now}
        keys={wide}
        closed={closed}
        onAnswer={(r) => answerQuestion(e.item, r)}
      />
    );
  };

  const comfy = !wide;
  const row = (e: Entry) =>
    e.type === "run" ? (
      <RunRow key={e.id} item={e.item} now={now} comfy={comfy} />
    ) : (
      <NeedRow
        key={e.id}
        entry={e}
        now={now}
        comfy={comfy}
        selected={wide && e.id === selected}
        onSelect={() => (wide ? setPicked(e.id) : setOpened(e.id))}
        actions={
          comfy ? (
            <RowActions entry={e} onPrompt={answerOne} onQuestion={answerQuestion} />
          ) : undefined
        }
      />
    );
  const sub = (label: React.ReactNode) => <div className={`t-caption ${s.sub}`}>{label}</div>;

  const count = needs.length;
  const list = (
    <section className={s.list} ref={listRef} aria-label="Inbox">
      <header className={`t-small ${s.head}`}>
        <span className={s.headTitle}>
          Needs you {count > 0 && <span className={s.count}>{count}</span>}
        </span>
        <span className={`t-key ${s.keys}`}>
          <kbd className={ui.kbd}>J</kbd> <kbd className={ui.kbd}>K</kbd>
        </span>
        <ViewMenu grouped={grouped} setGrouped={setGrouped} />
      </header>
      <PushBanner />
      {inbox.rejected.length > 0 && (
        <p className={`t-meta ${s.rejected}`} role="status">
          {inbox.rejected.length} hidden: failed verification ({inbox.rejected[0]?.error})
        </p>
      )}
      {grouped ? (
        byMachine(runEntries, needs).map((g) => (
          <div key={g.machine}>
            {sub(
              <>
                <Icon name={machineIcon(g.kind)} size={13} className={s.subIcon} /> {g.machine}
              </>,
            )}
            {g.entries.map(row)}
          </div>
        ))
      ) : (
        <>
          {runEntries.length > 0 && (
            <>
              {sub("Running")}
              {runEntries.map(row)}
            </>
          )}
          {needs.length > 0 && (
            <>
              {sub(comfy ? `Needs you · ${count}` : "Needs you")}
              {needs.map(row)}
            </>
          )}
        </>
      )}
      {needs.length === 0 && runEntries.length === 0 && (
        <p className={`t-small ${s.empty}`}>{find ? "Nothing matches" : "Nothing needs you"}</p>
      )}
      <div className={s.gap} />
      <HistoryHead
        open={historyOpen}
        count={closedToday(past, now)}
        comfy={comfy}
        onToggle={() => setHistoryOpen(!historyOpen)}
      />
      {historyOpen &&
        past.map((p) => (
          <PastRow
            key={p.entry.id}
            past={p}
            by={p.entry.type === "question" ? closedByPhrase(p.entry.item) : ""}
            selected={wide && p.entry.id === selected}
            onSelect={() => (wide ? setPicked(p.entry.id) : setOpened(p.entry.id))}
          />
        ))}
    </section>
  );

  if (!wide && opened) {
    return (
      <div className={s.single}>
        <PhoneBar title="Inbox" back={() => setOpened(undefined)} always />
        <div className={s.openDetail}>
          {detail(opened) ?? <p className={`t-small ${s.empty}`}>Answered</p>}
        </div>
      </div>
    );
  }
  if (!wide)
    return (
      <div className={s.single}>
        <PhoneBar
          title="Inbox"
          view={<ViewMenu grouped={grouped} setGrouped={setGrouped} icon />}
        />
        {list}
      </div>
    );
  return (
    <div className={s.panes}>
      <h1 className="sr-only">Inbox</h1>
      {list}
      <section className={s.detail} aria-label="Selected">
        {detail(selected)}
      </section>
      <QuotaAside />
    </div>
  );
}

/** History's second line: "Server first · on this browser · 11:02". */
function closedLine(p: Past): string {
  const by = p.entry.type === "question" ? ` · ${closedByPhrase(p.entry.item)}` : "";
  const at = new Date(p.closed).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${p.outcome}${by} · ${at}`;
}

/** On a phone's row: Allow and Deny, or the question's options. */
function RowActions({
  entry,
  onPrompt,
  onQuestion,
}: {
  entry: Entry;
  onPrompt: (
    p: PromptItem,
    r: Parameters<ReturnType<typeof useApp>["answerPrompt"]>[1],
  ) => Promise<void>;
  onQuestion: (
    i: InboxItem,
    r: Parameters<ReturnType<typeof useApp>["answer"]>[1],
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await f();
    } catch {
      // The detail shows errors; the row only retries.
    } finally {
      setBusy(false);
    }
  };
  if (entry.type === "prompt") {
    if (!promptOpen(entry.item, Date.now())) return null;
    return (
      <>
        <button
          type="button"
          className={`t-label ${ui.btn} ${ui.rec}`}
          disabled={busy}
          onClick={run(() => onPrompt(entry.item, { behavior: "allow", scope: "once" }))}
        >
          Allow
        </button>
        <button
          type="button"
          className={`t-label ${ui.btn}`}
          disabled={busy}
          onClick={run(() => onPrompt(entry.item, { behavior: "deny", scope: "once" }))}
        >
          Deny
        </button>
      </>
    );
  }
  if (entry.type !== "question" || entry.item.decision.answerIn) return null;
  const d = entry.item.decision;
  const options = ordered(d);
  if (options.length === 0) return null;
  return (
    <>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={`t-label ${ui.btn} ${o === d.recommended ? ui.rec : ""}`}
          disabled={busy}
          onClick={run(() => onQuestion(entry.item, { choice: o }))}
        >
          {o}
        </button>
      ))}
    </>
  );
}

/** One feed or Group by machine, remembered on this device. */
function ViewMenu({
  grouped,
  setGrouped,
  icon = false,
}: {
  grouped: boolean;
  setGrouped: (v: boolean) => void;
  icon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className={s.view} ref={ref}>
      <button
        type="button"
        className={icon ? s.iconButton : `t-meta ${ui.btn} ${ui.sm} ${open ? s.viewOpen : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={icon ? "View" : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="view" size={icon ? 22 : 16} />
        {!icon && "View"}
      </button>
      {open && (
        <div className={`t-small ${s.menu}`} role="menu">
          {(
            [
              ["One feed", false],
              ["Group by machine", true],
            ] as const
          ).map(([label, value]) => (
            <button
              key={label}
              type="button"
              role="menuitemradio"
              aria-checked={grouped === value}
              className={s.menuItem}
              onClick={() => {
                setGrouped(value);
                setOpen(false);
              }}
            >
              <span className={s.check}>
                {grouped === value && <Icon name="check" size={16} />}
              </span>
              {label}
            </button>
          ))}
          <div className={`t-caption ${s.menuNote}`}>Remembered on this device</div>
        </div>
      )}
    </div>
  );
}
