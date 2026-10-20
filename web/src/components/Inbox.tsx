"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { drafts } from "@/lib/drafts";
import {
  byMachine,
  closedToday,
  type Entry,
  history,
  isRecent,
  needsYou,
  type Past,
  promptOpen,
  running,
  snoozedEntries,
} from "@/lib/feed";
import { matches, useFind } from "@/lib/find";
import { clockTime } from "@/lib/format";
import { closeItem, linkedItem, openItem, replaceItem, stackItem, useOpened } from "@/lib/opened";
import { AnsweredFirst, answerPlace, promptOutcome } from "@/lib/outcome";
import { fitsRow } from "@/lib/permissionInput";
import { type Prefs, usePref } from "@/lib/prefs";
import { holdsQuotas } from "@/lib/quotaSettings";
import { runState } from "@/lib/runs";
import { afterAnswer, afterAnswerNarrow, selectedId, step } from "@/lib/selection";
import type { InboxItem, PromptItem } from "@/lib/types";
import { useApp } from "./AppProvider";
import { PromptDetail, QuestionDetail } from "./Detail";
import {
  HistoryHead,
  label,
  machineIcon,
  NeedRow,
  OlderHead,
  PastRow,
  RunRow,
  RunsHead,
  SnoozedHead,
  useNow,
  waitingSince,
} from "./Feed";
import feed from "./Feed.module.css";
import s from "./Inbox.module.css";
import { InstallBox } from "./InstallBox";
import { Icon } from "./icons";
import { ordered } from "./options";
import { PhoneBar } from "./PhoneBar";
import { PushBanner } from "./PushBanner";
import { QuotaAside } from "./QuotaAside";
import { RecoveryBanner } from "./RecoveryBanner";
import { Resizer } from "./Resizer";
import { pairedMachines } from "./Shell";
import ui from "./ui.module.css";

// From here the list and the detail sit side by side (Inbox.module.css).
const WIDE = "(min-width: 1100px)";
// A mouse or trackpad, where an answer under 1100 px opens the next card instead of the list.
const FINE = "(hover: hover) and (pointer: fine)";

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
    ? [
        e.item.permission.tool,
        e.item.permission.description,
        e.item.permission.summary,
        e.item.permission.source.sessionTitle,
      ]
    : e.type === "question"
      ? [e.item.decision.question, e.item.decision.context, e.item.decision.source.sessionTitle]
      : [e.item.run.title, e.item.run.reason];

/** History rows laid out at a time (#1459). */
const PAST_PAGE = 50;

/** The element `el` scrolls in: the list from 600 px, else the page. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === "auto" || y === "scroll") return p;
  }
  return null;
}

export function Inbox() {
  const app = useApp();
  const {
    inbox,
    inboxLoaded,
    promptsLoaded,
    prompts,
    runs,
    promptLog,
    loadPromptLog,
    answer,
    snooze,
    dismissRun,
    answerPrompt,
    deviceName,
    loadImages,
  } = app;
  const [grouping, setGrouping] = usePref("grouping");
  const [historyOpen, setHistoryOpen] = usePref("historyOpen");
  const [snoozedOpen, setSnoozedOpen] = usePref("snoozedOpen");
  const [runsOpen, setRunsOpen] = usePref("runsOpen");
  const [clock] = usePref("clock");
  // A section's rows fade in when the owner opens it, not when the page loads with it open or the
  // list comes back.
  const [historyToggled, setHistoryToggled] = useState(false);
  const [snoozedToggled, setSnoozedToggled] = useState(false);
  const [runsToggled, setRunsToggled] = useState(false);
  const snoozedRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const beforeToggle = useGlide([snoozedRef, historyRef], [snoozedOpen, historyOpen]);
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
  const showRuns = runsOpen || finding;
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
  // Find searches every row; the list shows the last 7 days until the owner asks for more.
  const [showOlder, setShowOlder] = useState(false);
  const older = finding || showOlder ? 0 : past.filter((p) => !isRecent(p, now)).length;
  const listed = older > 0 ? past.filter((p) => isRecent(p, now)) : past;
  const view = finding ? "none" : grouping;

  // A question another device answered first stays selected, saying what won (#330).
  const lost = useRef(new Set<string>());
  const ids = [
    ...needs,
    ...(showSnoozed ? snoozed : []),
    ...listed.filter((p) => showPast || lost.current.has(p.entry.id)).map((p) => p.entry),
  ].map((e) => e.id);
  const [picked, setPicked] = useState<string>();
  // Phones and narrow windows show the detail in place of the list once a row is tapped.
  const opened = useOpened();
  // What this page answered, which may still be listed as open until the inbox reloads.
  const answeredHere = useRef(new Set<string>());
  const firstOpen = needs.find((e) => !answeredHere.current.has(e.id))?.id;
  const selected = wide ? selectedId(ids, picked, firstOpen) : opened;
  // Opening an item mid-fade unmounts Snoozed or History before its animation ends.
  useEffect(() => {
    if (!opened) return;
    setHistoryToggled(false);
    setSnoozedToggled(false);
  }, [opened]);
  useEffect(() => {
    if (wide && selected && picked !== selected) setPicked(selected);
  }, [wide, selected, picked]);

  // Announces what arrived since the last list: the first full list this page loads, questions and
  // permission prompts both, is not news. A live region ignores text it already holds, so the
  // text clears first and a repeat is read out again.
  const [arrived, setArrived] = useState({ text: "", n: 0 });
  const [announced, setAnnounced] = useState("");
  const heard = useRef<Set<string>>(null);
  const waiting = all.filter((e) => e.type !== "run");
  const waitingKey = waiting.map((e) => e.id).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `waiting` changes with `waitingKey`
  useEffect(() => {
    if (!inboxLoaded || !promptsLoaded) return;
    const before = heard.current;
    heard.current = new Set(waiting.map((e) => e.id));
    const fresh = before ? waiting.filter((e) => !before.has(e.id)) : [];
    const [one] = fresh;
    if (!one) return;
    const text =
      fresh.length > 1
        ? `${fresh.length} new questions`
        : `New ${one.type === "prompt" ? "permission request" : "question"} from ${one.machine}: ${label(one)}`;
    setArrived((was) => ({ text, n: was.n + 1 }));
  }, [waitingKey, inboxLoaded, promptsLoaded]);
  useEffect(() => {
    setAnnounced("");
    if (!arrived.n) return;
    const timer = setTimeout(() => setAnnounced(arrived.text), 50);
    return () => clearTimeout(timer);
  }, [arrived]);
  // Mounted in every layout: an open question replaces the list on a narrow screen.
  const status = (
    <div className="sr-only" role="status">
      {announced}
    </div>
  );

  const latest = useRef({ ids, selected, wide });
  latest.current = { ids, selected, wide };
  const listRef = useRef<HTMLDivElement>(null);
  // History lays out its rows a page at a time, the next as the list scrolls near its end: 500
  // rows cost a phone over half a second on every switch to the Inbox (#1459).
  const [pastShown, setPastShown] = useState(PAST_PAGE);
  // A Find that scrolled far leaves no long list behind it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the query changes
  useEffect(() => setPastShown(PAST_PAGE), [find]);
  const pastMore = useRef<HTMLLIElement>(null);
  // Rows past the selected one too, so J lands on one laid out.
  const pastUpTo = Math.max(
    pastShown,
    listed.findIndex((p) => p.entry.id === selected) + PAST_PAGE,
  );
  const pastLeft = showPast && pastUpTo < listed.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: observes again after each page, so a sentinel still in view adds the next
  useEffect(() => {
    const end = pastMore.current;
    if (!pastLeft || !end) return;
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setPastShown((n) => n + PAST_PAGE);
      },
      { root: scroller(end), rootMargin: "100% 0px" },
    );
    seen.observe(end);
    return () => seen.disconnect();
  }, [pastLeft, pastUpTo]);
  useRowMotion(
    listRef,
    all.map((e) => e.id),
    `${grouping} ${find} ${wide}`,
  );
  // J and K at any width: beside the list they move the selection; in place of the list they open
  // the next card on the open one's history entry, so Back still returns to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], dialog")) return;
      const by = e.key === "j" || e.key === "J" ? 1 : e.key === "k" || e.key === "K" ? -1 : 0;
      if (!by) return;
      const { ids, selected, wide } = latest.current;
      const next = step(ids, selected, by);
      if (next === undefined) return;
      e.preventDefault();
      if (!wide) {
        if (selected === undefined) openItem(next);
        else if (next !== selected) {
          replaceItem(next);
          window.scrollTo(0, 0);
        }
        return;
      }
      setPicked(next);
      const list = listRef.current;
      const row = list?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`);
      if (list?.contains(document.activeElement)) row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openIds = needs.map((e) => e.id);
  // Beside the list, the next open item takes its place. In place of the list, it does too with a
  // mouse; on a touch screen the list comes back.
  const leave = (id: string) => {
    const next = afterAnswer(openIds, id);
    setPicked((cur) => (cur === id ? next : cur));
    if (wide || opened !== id) return next;
    const narrowNext = afterAnswerNarrow(openIds, id, window.matchMedia(FINE).matches);
    if (narrowNext === undefined) closeItem();
    else {
      replaceItem(narrowNext);
      window.scrollTo(0, 0);
    }
    return narrowNext;
  };
  const moveOn = (id: string) => {
    answeredHere.current.add(id);
    return leave(id);
  };
  // It moves on at the click, as the question leaves (#895). A refused answer brings its row back
  // saying why; one another device beat stays selected, saying what won (#330).
  const answerQuestion = async (item: InboxItem, reply: Parameters<typeof answer>[1]) => {
    const id = item.decision.id;
    const next = moveOn(id);
    try {
      await answer(item, reply);
      // Sent, the draft goes; a failed send keeps it to try again.
      drafts.delete(id);
    } catch (e) {
      if (e instanceof AnsweredFirst) {
        lost.current.add(id);
        setPicked((cur) => (cur === next ? id : cur));
      }
      throw e;
    }
  };
  // Put off, it leaves the open list as an answer does; brought back, it stays selected.
  const snoozeQuestion = async (item: InboxItem, until: Date) => {
    await snooze(item, until.toISOString());
    if (until.getTime() <= Date.now()) return;
    const next = leave(item.decision.id);
    // Its Snooze button leaves with the card, and focus with it: it goes to the next question's
    // row, else to the Snoozed head the question went under, so a keyboard user keeps their place
    // (#1943).
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body && at.isConnected) return;
      const list = listRef.current;
      const row = next ? list?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next)}"]`) : null;
      (row ?? list?.querySelector<HTMLElement>('[data-head="snoozed"]'))?.focus();
    });
  };
  const answerOne = async (item: PromptItem, reply: Parameters<typeof answerPrompt>[1]) => {
    await answerPrompt(item, reply);
    moveOn(item.permission.id);
  };

  const pastOf = new Map(past.map((p) => [p.entry.id, p]));
  // Find narrows the list, not the open card's detail (#1605).
  const entryOf = new Map(
    [...all.filter((e) => e.type !== "run"), ...snoozedEntries(inbox.items, now)].map((e) => [
      e.id,
      e,
    ]),
  );
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
  // In place of the list, an open card another device settled (or snoozed) while it was on screen
  // stays to say so, unless it was the last one: then the list returns, empty (#1583).
  const seenOpen = useRef<string | undefined>(undefined);
  // From every open card, not the ones Find keeps: a query that matches none settled nothing.
  const openAll = all.filter((e) => e.type !== "run");
  const listedOpen = opened !== undefined && openAll.some((e) => e.id === opened);
  useEffect(() => {
    if (wide || !opened) seenOpen.current = undefined;
    else if (listedOpen) seenOpen.current = opened;
    else if (seenOpen.current === opened && openAll.length === 0 && !lost.current.has(opened)) {
      seenOpen.current = undefined;
      closeItem();
    }
  }, [wide, opened, listedOpen, openAll.length]);
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
        lost={lost.current.has(id)}
        draft={drafts.get(id) ?? ""}
        onDraft={(t) => (t ? drafts.set(id, t) : drafts.delete(id))}
        onAnswer={(r) => answerQuestion(e.item, r)}
        onSnooze={(until) => snoozeQuestion(e.item, until)}
        onShowImages={() => {
          // Failed, they stay pending; opening the question again tries again.
          loadImages(e.item.decision.id).catch(() => {});
        }}
      />
    );
  };

  const comfy = !wide;
  const entryRow = (e: Entry, until?: string) =>
    e.type === "run" ? (
      <RunRow
        key={e.id}
        item={e.item}
        now={now}
        comfy={comfy}
        onDismiss={
          runState(e.item.run, now) === "running"
            ? undefined
            : () => dismissRun(e.item).catch(() => {})
        }
      />
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
            <RowActions
              entry={e}
              onPrompt={answerOne}
              onQuestion={answerQuestion}
              onOpen={() => (wide ? setPicked(e.id) : openItem(e.id))}
            />
          ) : undefined
        }
      />
    );
  const row = (e: Entry) => entryRow(e);
  const snoozedRow = (e: Entry) =>
    entryRow(e, e.type === "question" ? e.item.snoozedUntil : undefined);
  const sub = (label: React.ReactNode) => <h2 className={`t-caption ${s.sub}`}>{label}</h2>;
  // Under a grouping's header, the group's items share one box (#248).
  const grouped = view !== "none";
  const seg = (children: React.ReactNode, list?: boolean) => {
    const Box = list ? "ul" : "div";
    return <Box className={`${feed.seg} ${comfy ? feed.comfy : ""}`}>{children}</Box>;
  };

  const count = needs.length;
  // Nothing can reach this inbox until a machine pairs: say how (#610).
  const noMachine = pairedMachines(app) === 0;
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
          onToggle={() => {
            beforeToggle();
            setSnoozedOpen(!snoozedOpen);
            setSnoozedToggled(true);
          }}
        />
      )}
      {showSnoozed && (
        <ul
          className={`${feed.items} ${snoozedToggled ? "m-appear" : ""}`}
          onAnimationEnd={() => setSnoozedToggled(false)}
        >
          {snoozed.map(snoozedRow)}
        </ul>
      )}
    </>
  );
  // Runs, their own section at the top (#835): closing it keeps failed and lost runs named.
  const runsPart = runEntries.length > 0 && (
    <>
      {finding ? (
        sub(`Runs · ${runEntries.length}`)
      ) : (
        <RunsHead
          open={runsOpen}
          runs={runEntries.map((e) => (e as Extract<Entry, { type: "run" }>).item)}
          now={now}
          comfy={comfy}
          onToggle={() => {
            setRunsOpen(!runsOpen);
            setRunsToggled(true);
          }}
        />
      )}
      {showRuns && (
        <div
          className={runsToggled ? "m-appear" : undefined}
          onAnimationEnd={() => setRunsToggled(false)}
        >
          {runEntries.map(row)}
        </div>
      )}
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
            beforeToggle();
            setHistoryOpen(!historyOpen);
            setHistoryToggled(true);
          }}
        />
      )}
      {showPast && (
        <ul
          className={`${feed.items} ${historyToggled ? "m-appear" : ""}`}
          onAnimationEnd={() => setHistoryToggled(false)}
        >
          {listed.slice(0, pastUpTo).map((p) => (
            <PastRow
              key={p.entry.id}
              past={p}
              comfy={comfy}
              selected={wide && p.entry.id === selected}
              onSelect={() => (wide ? setPicked(p.entry.id) : openItem(p.entry.id))}
            />
          ))}
          {pastLeft && <li ref={pastMore} className={s.pastMore} aria-hidden="true" />}
          {older > 0 && (
            <li>
              <OlderHead count={older} comfy={comfy} onShow={() => setShowOlder(true)} />
            </li>
          )}
        </ul>
      )}
    </>
  );
  const list = (
    <section className={s.list} ref={listRef} aria-label="Inbox">
      <header className={`t-small ${s.head}`}>
        <h2 className={s.headTitle}>
          Needs you {count > 0 && <span className={s.count}>{count}</span>}
        </h2>
        <ViewMenu grouping={grouping} setGrouping={setGrouping} />
      </header>
      <RecoveryBanner />
      <PushBanner />
      {inbox.rejected.length > 0 && (
        <p className={`t-meta ${s.rejected}`} role="status">
          {inbox.rejected.length} hidden: failed verification ({inbox.rejected[0]?.error})
        </p>
      )}
      {/* The gap History has above it, so Runs does not sit flush under the header (#868). */}
      {runsPart && <div className={s.gap} />}
      {runsPart && (grouped ? seg(runsPart) : runsPart)}
      {view === "waiting" ? (
        <>
          {waitingOn.length > 0 && (
            <>
              {sub(
                <>
                  Waiting on you <span className={s.count}>{waitingOn.length}</span>
                </>,
              )}
              {seg(waitingOn.map(row), true)}
            </>
          )}
          {whenYouCan.length > 0 && (
            <>
              {sub(
                <>
                  When you can <span className={s.countQuiet}>{whenYouCan.length}</span>
                </>,
              )}
              {seg(whenYouCan.map(row), true)}
            </>
          )}
        </>
      ) : view === "machine" ? (
        byMachine(needs).map((g) => (
          <div key={g.machine}>
            {sub(
              <>
                <Icon name={machineIcon(g.kind)} size={13} className={s.subIcon} /> {g.machine}
              </>,
            )}
            {seg(g.entries.map(row), true)}
          </div>
        ))
      ) : (
        needs.length > 0 && (
          <>
            {sub(comfy ? `Needs you · ${count}` : "Needs you")}
            <ul className={feed.items}>{needs.map(row)}</ul>
          </>
        )
      )}
      {needs.length === 0 &&
        runEntries.length === 0 &&
        (!finding ? (
          noMachine && !wide ? (
            <NoMachine />
          ) : (
            <p className={`t-small ${s.empty}`}>Nothing needs you</p>
          )
        ) : past.length === 0 && snoozed.length === 0 ? (
          <p className={`t-small ${s.empty}`}>Nothing matches</p>
        ) : null)}
      {/* Closed, Snoozed waits just above History at the bottom (#682). Only the first of them
          down takes the space, so they sit together. */}
      {snoozedPart && (
        <div ref={snoozedRef} className={showSnoozed || showPast ? undefined : s.down}>
          <div className={s.gap} />
          {grouped ? seg(snoozedPart) : snoozedPart}
        </div>
      )}
      <div
        ref={historyRef}
        className={showPast || (snoozedPart && !showSnoozed) ? undefined : s.down}
      >
        <div className={s.gap} />
        {grouped ? seg(historyPart) : historyPart}
      </div>
    </section>
  );

  if (!wide && opened) {
    return (
      <div className={s.single}>
        {status}
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
        {status}
        <PhoneBar
          title="Inbox"
          view={<ViewMenu grouping={grouping} setGrouping={setGrouping} icon />}
        />
        {list}
      </div>
    );
  return (
    <Panes list={list} status={status}>
      <section className={s.detail} aria-label="Selected">
        {detail(selected) ?? (noMachine && <NoMachine />)}
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
function Panes({
  list,
  status,
  children,
}: {
  list: React.ReactNode;
  status: React.ReactNode;
  children: React.ReactNode;
}) {
  const [listPref, setList] = usePref("listWidth");
  const [asidePref, setAside] = usePref("asideWidth");
  const vw = useWindowWidth();
  // No quotas yet, no column for them (#914).
  const quotas = holdsQuotas(useApp().quotas);
  const aside = vw >= ASIDE_FROM && quotas;
  const room = vw - token("--size-rail") - DETAIL_MIN;
  const asideW = aside ? Math.min(asidePref ?? token("--size-aside"), room / 2) : 0;
  const listW = Math.min(listPref ?? token("--size-list"), room - asideW);
  const style = {
    "--pane-list": `${listW}px`,
    ...(aside ? { "--pane-aside": `${asideW}px` } : {}),
  } as React.CSSProperties;
  return (
    <div className={`${s.panes} ${quotas ? "" : s.noAside}`} style={style}>
      <h1 className="sr-only">Inbox</h1>
      {status}
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
      {quotas && <QuotaAside />}
    </div>
  );
}

/**
 * Snoozed and History glide between the list's bottom and their place under the items (#662,
 * #682): call the returned function before a toggle, and each element is played back from where
 * it was to where it lands (FLIP). Reduced motion makes it a jump.
 */
function useGlide(els: React.RefObject<HTMLElement | null>[], toggles: boolean[]): () => void {
  const from = useRef<(number | undefined)[]>(undefined);
  const toggled = toggles.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each toggle's render.
  useLayoutEffect(() => {
    const tops = from.current;
    from.current = undefined;
    if (!tops) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = getComputedStyle(document.documentElement);
    // The browser may give the token back in seconds ("0.25s") or milliseconds.
    const t = root.getPropertyValue("--t-state").trim();
    const duration = Number.parseFloat(t) * (t.endsWith("ms") ? 1 : 1000) || 250;
    const easing = root.getPropertyValue("--ease").trim() || "ease-out";
    els.forEach((ref, i) => {
      const el = ref.current;
      const top = tops[i];
      if (!el || top === undefined) return;
      // A toggle mid-glide: where it lands is measured without the glide still running.
      for (const a of el.getAnimations()) a.cancel();
      const by = top - el.getBoundingClientRect().top;
      if (Math.abs(by) < 1 || reduce) return;
      el.animate([{ transform: `translateY(${by}px)` }, { transform: "none" }], {
        duration,
        easing,
      });
    });
  }, [toggled]);
  return () => {
    from.current = els.map((ref) => ref.current?.getBoundingClientRect().top);
  };
}

// Items listed this soon after the list shows came with the page, so they don't fade in.
const SETTLE = 1500;

/** A duration token from tokens.css, in ms. */
function ms(name: "--t-fast" | "--t-state"): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** A node and its neighbours, to put it back where it was. */
type Spot = { node: Element; prev: Element | null; next: Element | null };
/** A row, and the nodes above it up to the list's child (its group, a section's wrapper). */
type Placed = { row: HTMLElement; own: Spot; above: Spot[] };

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
            const above: Spot[] = [];
            for (let n = r.parentElement; n && n !== el; n = n.parentElement) above.push(spot(n));
            return [r.dataset.row as string, { row: r, own: spot(r), above }];
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
    for (const [id, { row, own, above }] of was.rows) {
      if (now.tops.has(id) || ids.includes(id) || row.isConnected) continue;
      // The highest node that left: the row, or the group or section body it was in. A node
      // still in the page, such as a section's head, stays where React put it.
      const at = [own, ...above].filter((x) => !x.node.isConnected).pop();
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
  onOpen,
}: {
  entry: Entry;
  /** Opens the item: Allow does, for a prompt whose input the row can't show whole. */
  onOpen: () => void;
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
    // Allow answers only where the row shows the whole input (#274); otherwise it opens the
    // prompt, whose detail shows it all, as Android's and the iPhone's cards do.
    const fits = fitsRow(entry.item.permission);
    return (
      <>
        <button
          type="button"
          className={`t-label ${ui.btn} ${ui.rec}`}
          disabled={busy}
          onClick={
            fits ? run(() => onPrompt(entry.item, { behavior: "allow", scope: "once" })) : onOpen
          }
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
        aria-label="Group by"
        title={icon ? undefined : "Group by"}
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

/** The empty inbox of an account with no machine: what to install, where, and Add a device. */
function NoMachine() {
  return (
    <div className={s.noMachine}>
      <h2 className="t-heading">Add a machine</h2>
      <p className={`t-small ${s.noMachineText}`}>
        Install Starbridge on each machine that runs your agents. Setup prints a link: open it and
        approve the machine.
      </p>
      <InstallBox setup />
      {/* Where the pairing code goes, one tap away (#1367), for a link that opens elsewhere (#2140). */}
      <div>
        <Link href="/settings/devices/add?machine" className={`t-meta ${ui.btn} ${ui.sm}`}>
          Type a code instead
        </Link>
      </div>
      <p className={`t-small ${s.noMachineText}`}>
        What setup does: <a href="/docs">the docs</a>
      </p>
    </div>
  );
}
