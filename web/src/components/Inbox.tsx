"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  byMachine,
  closedToday,
  type Entry,
  history,
  needsYou,
  type Past,
  promptOpen,
  running,
  snoozedEntries,
} from "@/lib/feed";
import { matches, useFind } from "@/lib/find";
import { clockTime } from "@/lib/format";
import { closeItem, linkedItem, openItem, stackItem, useOpened } from "@/lib/opened";
import { AnsweredFirst, answerPlace, promptOutcome } from "@/lib/outcome";
import { fitsRow } from "@/lib/permissionInput";
import { type Prefs, usePref } from "@/lib/prefs";
import { afterAnswer, selectedId, step } from "@/lib/selection";
import type { InboxItem, PromptItem } from "@/lib/types";
import { useApp } from "./AppProvider";
import { PromptDetail, QuestionDetail } from "./Detail";
import {
  HistoryHead,
  machineIcon,
  NeedRow,
  PastRow,
  RunRow,
  SnoozedHead,
  useNow,
  waitingSince,
} from "./Feed";
import feed from "./Feed.module.css";
import s from "./Inbox.module.css";
import { Icon } from "./icons";
import { ordered } from "./options";
import { PhoneBar } from "./PhoneBar";
import { PushBanner } from "./PushBanner";
import { QuotaAside } from "./QuotaAside";
import { RecoveryBanner } from "./RecoveryBanner";
import { Resizer } from "./Resizer";
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
  const {
    inbox,
    inboxLoaded,
    prompts,
    runs,
    promptLog,
    loadPromptLog,
    answer,
    snooze,
    answerPrompt,
    deviceName,
  } = useApp();
  const [grouping, setGrouping] = usePref("grouping");
  const [historyOpen, setHistoryOpen] = usePref("historyOpen");
  const [snoozedOpen, setSnoozedOpen] = usePref("snoozedOpen");
  const [clock] = usePref("clock");
  // History's rows fade in when the owner opens it, not when the page loads with it open or the
  // list comes back.
  const [historyToggled, setHistoryToggled] = useState(false);
  const find = useFind();
  // Find searches History too, so its prompt log loads once a query starts, not per keystroke.
  const finding = find.trim() !== "";
  const wide = useWide();
  const live =
    prompts.length > 0 || inbox.items.some((i) => i.waitingSince) || !!runs?.items.length;
  // Every second while a timer shows, else every minute so the times since stay current.
  const now = useNow(true, live ? 1000 : 60_000);

  useEffect(() => {
    if (historyOpen || finding) loadPromptLog().catch(() => {});
  }, [historyOpen, finding, loadPromptLog]);

  const keep = (e: Entry) => !find || matches(find, [e.machine, e.repo, ...text(e)]);
  const all = [...needsYou(inbox.items, prompts, now), ...running(runs?.items ?? [], now)];
  const needs = all.filter((e) => e.type !== "run" && keep(e));
  const runEntries = all.filter((e) => e.type === "run" && keep(e));
  const snoozed = snoozedEntries(inbox.items, now).filter(keep);
  const showSnoozed = snoozedOpen || finding;
  const allPrompts = useMemo(() => {
    const seen = new Map<string, PromptItem>();
    for (const p of [...(promptLog ?? []), ...prompts]) seen.set(p.permission.id, p);
    return [...seen.values()];
  }, [promptLog, prompts]);
  // History's matches, answers included, list under the open items while finding.
  const past = history(inbox.items, allPrompts, (p) => promptOutcome(p, deviceName), now).filter(
    (p) =>
      !finding || matches(find, [p.entry.machine, p.entry.repo, ...text(p.entry), p.outcome, p.by]),
  );
  const showPast = historyOpen || finding;
  const view = finding ? "none" : grouping;

  // A question another device answered first stays selected, saying what won (#330).
  const lost = useRef(new Set<string>());
  const ids = [
    ...needs,
    ...(showSnoozed ? snoozed : []),
    ...past.filter((p) => showPast || lost.current.has(p.entry.id)).map((p) => p.entry),
  ].map((e) => e.id);
  const [picked, setPicked] = useState<string>();
  // Phones and narrow windows show the detail in place of the list once a row is tapped.
  const opened = useOpened();
  // What this page answered, which may still be listed as open until the inbox reloads.
  const answeredHere = useRef(new Set<string>());
  const firstOpen = needs.find((e) => !answeredHere.current.has(e.id))?.id;
  const selected = wide ? selectedId(ids, picked, firstOpen) : opened;
  // Opening an item mid-fade unmounts History before its animation ends.
  useEffect(() => {
    if (opened) setHistoryToggled(false);
  }, [opened]);
  useEffect(() => {
    if (wide && selected && picked !== selected) setPicked(selected);
  }, [wide, selected, picked]);

  const latest = useRef({ ids, selected });
  latest.current = { ids, selected };
  const listRef = useRef<HTMLDivElement>(null);
  useRowMotion(
    listRef,
    all.map((e) => e.id),
    `${grouping} ${find} ${wide}`,
  );
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
    answeredHere.current.add(id);
    const next = afterAnswer(openIds, id);
    setPicked((cur) => (cur === id ? next : cur));
  };
  const answerQuestion = async (item: InboxItem, reply: Parameters<typeof answer>[1]) => {
    try {
      await answer(item, reply);
    } catch (e) {
      if (e instanceof AnsweredFirst) lost.current.add(item.decision.id);
      throw e;
    }
    moveOn(item.decision.id);
  };
  // Put off, it leaves the open list as an answer does; brought back, it stays selected.
  const snoozeQuestion = async (item: InboxItem, until: Date) => {
    await snooze(item, until.toISOString());
    if (until.getTime() <= Date.now()) return;
    if (!wide) closeItem();
    const next = afterAnswer(openIds, item.decision.id);
    setPicked((cur) => (cur === item.decision.id ? next : cur));
  };
  const answerOne = async (item: PromptItem, reply: Parameters<typeof answerPrompt>[1]) => {
    await answerPrompt(item, reply);
    moveOn(item.permission.id);
  };

  const pastOf = new Map(past.map((p) => [p.entry.id, p]));
  const entryOf = new Map([...needs, ...snoozed].map((e) => [e.id, e]));
  // An item opened by a link or a reload is known once the inbox loaded, or the 7-day prompt
  // log for a closed prompt; after one try at the log, an unknown id counts as answered.
  const stillOpen = opened !== undefined && entryOf.has(opened);
  const known = stillOpen || (opened !== undefined && pastOf.has(opened));
  const [logTried, setLogTried] = useState(false);
  const resolved = known || (inboxLoaded && (promptLog !== undefined || logTried));
  useEffect(() => {
    if (!opened || !inboxLoaded || known || promptLog !== undefined || logTried) return;
    loadPromptLog()
      .catch(() => {})
      .finally(() => setLogTried(true));
  }, [opened, inboxLoaded, known, promptLog, logTried, loadPromptLog]);
  useEffect(() => {
    if (opened && !wide) stackItem();
  }, [opened, wide]);
  // A wide window selects the item beside the list instead, opening History for a linked closed one.
  useEffect(() => {
    if (!wide || !opened || !resolved) return;
    if (known) {
      setPicked(opened);
      if (!stillOpen && linkedItem()) setHistoryOpen(true);
    }
    closeItem();
  }, [wide, opened, resolved, known, stillOpen, setHistoryOpen]);
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
        onSnooze={(until) => snoozeQuestion(e.item, until)}
      />
    );
  };

  const comfy = !wide;
  const entryRow = (e: Entry, until?: string) =>
    e.type === "run" ? (
      <RunRow key={e.id} item={e.item} now={now} comfy={comfy} />
    ) : (
      <NeedRow
        key={e.id}
        entry={e}
        now={now}
        comfy={comfy}
        selected={wide && e.id === selected}
        onSelect={() => (wide ? setPicked(e.id) : openItem(e.id))}
        until={until}
        clock={clock}
        // A snoozed row stays quiet, with no amber default: the owner opens it to answer.
        actions={
          comfy && !until ? (
            <RowActions entry={e} onPrompt={answerOne} onQuestion={answerQuestion} />
          ) : undefined
        }
      />
    );
  const row = (e: Entry) => entryRow(e);
  const snoozedRow = (e: Entry) =>
    entryRow(e, e.type === "question" ? e.item.snoozedUntil : undefined);
  const sub = (label: React.ReactNode) => <div className={`t-caption ${s.sub}`}>{label}</div>;
  // Under a grouping's header, the group's items share one box (#248).
  const grouped = view !== "none";
  const seg = (children: React.ReactNode) => (
    <div className={`${feed.seg} ${comfy ? feed.comfy : ""}`}>{children}</div>
  );

  const count = needs.length;
  const waitingOn = needs.filter((e) => waitingSince(e));
  const whenYouCan = needs.filter((e) => !waitingSince(e));
  // Questions the owner put off (#571), collapsed at the end, out of the count; Find opens it.
  const snoozedPart = snoozed.length > 0 && (
    <>
      {finding ? (
        sub(`Snoozed · ${snoozed.length}`)
      ) : (
        <SnoozedHead
          open={snoozedOpen}
          count={snoozed.length}
          comfy={comfy}
          onToggle={() => setSnoozedOpen(!snoozedOpen)}
        />
      )}
      {showSnoozed && snoozed.map(snoozedRow)}
    </>
  );
  const historyPart = (
    <>
      {finding ? (
        past.length > 0 && sub(`History · ${past.length}`)
      ) : (
        <HistoryHead
          open={historyOpen}
          count={closedToday(past, now)}
          comfy={comfy}
          onToggle={() => {
            setHistoryOpen(!historyOpen);
            setHistoryToggled(true);
          }}
        />
      )}
      {showPast && (
        <div
          className={historyToggled ? "m-appear" : undefined}
          onAnimationEnd={() => setHistoryToggled(false)}
        >
          {past.map((p) => (
            <PastRow
              key={p.entry.id}
              past={p}
              comfy={comfy}
              selected={wide && p.entry.id === selected}
              onSelect={() => (wide ? setPicked(p.entry.id) : openItem(p.entry.id))}
            />
          ))}
        </div>
      )}
    </>
  );
  const list = (
    <section className={s.list} ref={listRef} aria-label="Inbox">
      <header className={`t-small ${s.head}`}>
        <span className={s.headTitle}>
          Needs you {count > 0 && <span className={s.count}>{count}</span>}
        </span>
        <span className={`t-key ${s.keys}`}>
          <kbd className={ui.kbd}>J</kbd> <kbd className={ui.kbd}>K</kbd>
        </span>
        <ViewMenu grouping={grouping} setGrouping={setGrouping} />
      </header>
      <RecoveryBanner />
      <PushBanner />
      {inbox.rejected.length > 0 && (
        <p className={`t-meta ${s.rejected}`} role="status">
          {inbox.rejected.length} hidden: failed verification ({inbox.rejected[0]?.error})
        </p>
      )}
      {view === "waiting" ? (
        <>
          {runEntries.length > 0 && (
            <>
              {sub("Running")}
              {seg(runEntries.map(row))}
            </>
          )}
          {waitingOn.length > 0 && (
            <>
              {sub(
                <>
                  Waiting on you <span className={s.count}>{waitingOn.length}</span>
                </>,
              )}
              {seg(waitingOn.map(row))}
            </>
          )}
          {whenYouCan.length > 0 && (
            <>
              {sub(
                <>
                  When you can <span className={s.countQuiet}>{whenYouCan.length}</span>
                </>,
              )}
              {seg(whenYouCan.map(row))}
            </>
          )}
        </>
      ) : view === "machine" ? (
        byMachine(runEntries, needs).map((g) => (
          <div key={g.machine}>
            {sub(
              <>
                <Icon name={machineIcon(g.kind)} size={13} className={s.subIcon} /> {g.machine}
              </>,
            )}
            {seg(g.entries.map(row))}
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
      {needs.length === 0 &&
        runEntries.length === 0 &&
        (!finding ? (
          <p className={`t-small ${s.empty}`}>Nothing needs you</p>
        ) : past.length === 0 && snoozed.length === 0 ? (
          <p className={`t-small ${s.empty}`}>Nothing matches</p>
        ) : null)}
      {snoozedPart && (
        <>
          <div className={s.gap} />
          {grouped ? seg(snoozedPart) : snoozedPart}
        </>
      )}
      <div className={s.gap} />
      {grouped ? seg(historyPart) : historyPart}
    </section>
  );

  if (!wide && opened) {
    return (
      <div className={s.single}>
        <PhoneBar title="Inbox" back={closeItem} always />
        <div className={`m-enter ${s.openDetail}`}>
          {detail(opened) ?? (resolved && <p className={`t-small ${s.empty}`}>Answered</p>)}
        </div>
      </div>
    );
  }
  if (!wide)
    return (
      <div className={s.single}>
        <PhoneBar
          title="Inbox"
          view={<ViewMenu grouping={grouping} setGrouping={setGrouping} icon />}
        />
        {list}
      </div>
    );
  return (
    <Panes list={list}>
      <section className={s.detail} aria-label="Selected">
        {detail(selected)}
      </section>
    </Panes>
  );
}

/** Defaults before the owner drags an edge: tokens.css's, also for a render on the server. */
const SIZES = { "--size-rail": 240, "--size-list": 420, "--size-aside": 320 };

function token(name: keyof typeof SIZES): number {
  if (typeof document === "undefined") return SIZES[name];
  const px = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(px) ? px : SIZES[name];
}

function useWindowWidth(): number {
  return useSyncExternalStore(
    (change) => {
      window.addEventListener("resize", change);
      return () => window.removeEventListener("resize", change);
    },
    () => window.innerWidth,
    () => 1440,
  );
}

// The open question keeps at least this much; Quota windows show from 1400 px (Inbox.module.css).
const DETAIL_MIN = 400;
const ASIDE_FROM = 1400;

/** The wide layout: list, open item and Quota windows, with edges the owner drags (#173). */
function Panes({ list, children }: { list: React.ReactNode; children: React.ReactNode }) {
  const [listPref, setList] = usePref("listWidth");
  const [asidePref, setAside] = usePref("asideWidth");
  const vw = useWindowWidth();
  const aside = vw >= ASIDE_FROM;
  const room = vw - token("--size-rail") - DETAIL_MIN;
  const asideW = aside ? Math.min(asidePref ?? token("--size-aside"), room / 2) : 0;
  const listW = Math.min(listPref ?? token("--size-list"), room - asideW);
  const style = {
    "--pane-list": `${listW}px`,
    ...(aside ? { "--pane-aside": `${asideW}px` } : {}),
  } as React.CSSProperties;
  return (
    <div className={s.panes} style={style}>
      <h1 className="sr-only">Inbox</h1>
      {list}
      <Resizer
        label="Inbox width"
        width={listW}
        min={300}
        max={Math.max(300, room - asideW)}
        side="left"
        onChange={setList}
      />
      {children}
      {aside && (
        <Resizer
          label="Quota windows width"
          width={asideW}
          min={260}
          max={Math.max(260, room - listW)}
          side="right"
          onChange={setAside}
        />
      )}
      <QuotaAside />
    </div>
  );
}

// Items listed this soon after the list shows came with the page, so they don't fade in.
const SETTLE = 1500;

/** A duration token from tokens.css, in ms. */
function ms(name: "--t-fast" | "--t-state"): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** A node and its neighbours, to put it back where it was. */
type Spot = { node: Element; prev: Element | null; next: Element | null };
/** A row, and its group when it sits in one (Group by machine). */
type Placed = { row: HTMLElement; own: Spot; group?: Spot };

const spot = (node: Element): Spot => ({
  node,
  prev: node.previousElementSibling,
  next: node.nextElementSibling,
});
type Snapshot = {
  list: HTMLElement;
  view: string;
  shown: number;
  seen: Set<string>;
  order: string[];
  tops: Map<string, number>;
  rows: Map<string, Placed>;
};

/**
 * The list's motion (DESIGN.md, "Motion and states"): an item that arrives while the page is
 * open fades in; an answered item fades out where it was, then the list closes up at once; a row
 * whose place in the order changes, such as a question that flips to waiting (#191), slides
 * there. Rows that only shift because others came or left stay put, and a change of view or
 * filter moves nothing. `ids` holds every open item, filtered out or not.
 */
function useRowMotion(list: React.RefObject<HTMLElement | null>, ids: string[], view: string) {
  const last = useRef<Snapshot>(undefined);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const rows = [...el.querySelectorAll<HTMLElement>("[data-row]")];
      return {
        order: rows.map((r) => r.dataset.row as string),
        // Layout position: unmoved by page or list scroll, and by a move still running.
        tops: new Map(rows.map((r) => [r.dataset.row as string, r.offsetTop])),
        rows: new Map<string, Placed>(
          rows.map((r): [string, Placed] => {
            let group = r.parentElement;
            while (group && group.parentElement !== el) group = group.parentElement;
            const placed = { row: r, own: spot(r), group: group ? spot(group) : undefined };
            return [r.dataset.row as string, placed];
          }),
        ),
      };
    };
    const now = measure();
    const was = last.current;
    const fresh = !was || was.list !== el;
    const shown = fresh ? performance.now() : was.shown;
    const seen = new Set([...(fresh ? [] : was.seen), ...ids]);
    last.current = { list: el, view, shown, seen, ...now };
    if (fresh || was.view !== view) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const easing = getComputedStyle(el).getPropertyValue("--ease").trim() || "ease-out";
    const before = was.order.filter((id) => now.tops.has(id));
    const after = now.order.filter((id) => was.tops.has(id));
    after.forEach((id, i) => {
      if (before[i] === id) return;
      const dy = (was.tops.get(id) as number) - (now.tops.get(id) as number);
      if (Math.abs(dy) < 1) return;
      now.rows.get(id)?.row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: ms("--t-state"),
        easing,
      });
    });

    const settled = performance.now() - shown > SETTLE;
    for (const [id, { row }] of now.rows)
      if (settled && !was.tops.has(id) && !was.seen.has(id))
        row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms("--t-state"), easing });

    // Answered or gone: put the row back where it was, with its group if that left too, inert;
    // fade it out, then close up.
    const back = new Set<Element>();
    for (const [id, { row, own, group }] of was.rows) {
      if (now.tops.has(id) || ids.includes(id) || row.isConnected) continue;
      const at = row.parentElement && !row.parentElement.isConnected ? group : own;
      if (!at || back.has(at.node)) continue;
      const { node, prev, next } = at;
      if (prev?.parentElement && el.contains(prev)) prev.after(node);
      else if (next?.parentElement && el.contains(next)) next.before(node);
      else continue;
      back.add(node);
      for (const a of node.getAnimations({ subtree: true })) a.cancel();
      for (const n of node.querySelectorAll("[data-row]")) n.removeAttribute("data-row");
      for (const n of node.querySelectorAll("[data-id]")) n.removeAttribute("data-id");
      node.removeAttribute("data-row");
      node.setAttribute("aria-hidden", "true");
      (node as HTMLElement).inert = true;
      node
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: ms("--t-fast"),
          easing,
          fill: "forwards",
        })
        .finished.catch(() => {})
        .then(() => {
          node.remove();
          if (last.current?.list === el) Object.assign(last.current, measure());
        });
    }
  });
}

/** History's second line: "Server first · on this browser · 11:02". */
function closedLine(p: Past): string {
  return [p.outcome, p.by, clockTime(new Date(p.closed))].filter(Boolean).join(" · ");
}

/**
 * On a narrow screen's row: Allow and Deny, or the question's options when the Answer buttons setting
 * allows them (#138). Prompts keep theirs: their agent always waits.
 */
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
  const [when] = usePref("rowAnswers");
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
    // Allow only where the row shows the whole input (#274); otherwise the detail has it.
    return (
      <>
        {fitsRow(entry.item.permission) && (
          <button
            type="button"
            className={`t-label ${ui.btn} ${ui.rec}`}
            disabled={busy}
            onClick={run(() => onPrompt(entry.item, { behavior: "allow", scope: "once" }))}
          >
            Allow
          </button>
        )}
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
  if (entry.type !== "question") return null;
  if (when === "never" || (when === "waiting" && !entry.item.waitingSince)) return null;
  const d = entry.item.decision;
  if (d.answerIn) {
    if (!d.done) return null;
    return (
      <>
        <a
          className={`t-label ${ui.btn} ${ui.rec}`}
          href={d.answerIn.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Answer in {answerPlace(d.answerIn)}
        </a>
        <button
          type="button"
          className={`t-label ${ui.btn}`}
          disabled={busy}
          onClick={run(() => onQuestion(entry.item, { done: true }))}
        >
          Done
        </button>
      </>
    );
  }
  const options = ordered(d);
  if (options.length === 0) return null;
  return (
    <>
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          className={`t-label ${ui.btn} ${i === 0 ? ui.rec : ""}`}
          disabled={busy}
          onClick={run(() => onQuestion(entry.item, { choice: o }))}
        >
          {o}
        </button>
      ))}
    </>
  );
}

/** One feed, Group by machine or Group by waiting, remembered on this device. */
function ViewMenu({
  grouping,
  setGrouping,
  icon = false,
}: {
  grouping: Prefs["grouping"];
  setGrouping: (v: Prefs["grouping"]) => void;
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
        className={
          icon ? s.iconButton : `${ui.btn} ${ui.sm} ${s.viewButton} ${open ? s.viewOpen : ""}`
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="View"
        title={icon ? undefined : "View"}
        onClick={() => setOpen(!open)}
      >
        <Icon name="view" size={icon ? 22 : 16} />
      </button>
      {open && (
        <div className={`t-small m-drop ${s.menu}`} role="menu">
          {(
            [
              ["One feed", "none"],
              ["Group by machine", "machine"],
              ["Group by waiting", "waiting"],
            ] as const
          ).map(([label, value]) => (
            <button
              key={label}
              type="button"
              role="menuitemradio"
              aria-checked={grouping === value}
              className={s.menuItem}
              onClick={() => {
                setGrouping(value);
                setOpen(false);
              }}
            >
              <span className={s.check}>
                {grouping === value && <Icon name="check" size={16} />}
              </span>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
