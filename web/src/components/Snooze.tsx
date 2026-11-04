"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePref } from "@/lib/prefs";
import {
  dayLabel,
  hhmm,
  onDay,
  pickDays,
  pickTimes,
  snoozePresets,
  snoozeStart,
  snoozeTakes,
  snoozeTime,
} from "@/lib/snooze";
import { Icon } from "./icons";
import s from "./Snooze.module.css";
import ui from "./ui.module.css";

/**
 * Snooze's round icon button and its times (#571, #699, #1848), up to 7 days ahead. Quiet, as
 * Done: putting a question off is never the default. `label` names it for screen readers and the
 * tooltip. Its icon is a clock, on the web and in the Mac app alike. The button ends the card, so
 * the times open above it when they would run past the pane's bottom, and always scroll into view
 * (#2247).
 */
export function SnoozeMenu({
  label,
  disabled,
  onSnooze,
}: {
  label: string;
  disabled?: boolean;
  onSnooze: (until: Date) => void;
}) {
  const [clock] = usePref("clock");
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const m = menu.current;
    const t = trigger.current;
    if (!open || !m || !t) return;
    if (!up && getComputedStyle(m).position === "absolute") {
      const view = visibleBox(m);
      const below = m.getBoundingClientRect();
      if (below.bottom > view.bottom && t.getBoundingClientRect().top - below.height >= view.top) {
        setUp(true);
        return;
      }
    }
    m.scrollIntoView({ block: "nearest" });
  }, [open, up]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        // Focus goes back to the button that opened it, not to the page.
        trigger.current?.focus();
        setOpen(false);
      } else if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const now = new Date();
  const pick = (until: Date) => {
    setOpen(false);
    trigger.current?.focus();
    onSnooze(until);
  };
  return (
    <div className={s.snooze} ref={ref}>
      <button
        ref={trigger}
        type="button"
        className={s.trigger}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setUp(false);
          setOpen(!open);
        }}
      >
        <Icon name="clock" size={22} />
      </button>
      {open && <SnoozeTimes now={now} clock={clock} up={up} menuRef={menu} onPick={pick} />}
    </div>
  );
}

/** The part of the window that shows `el`: its nearest scrolling ancestor's box, clipped to it. */
function visibleBox(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
    break;
  }
  return { top, bottom };
}

/**
 * Snooze's times, straight on today (#699, as Android's #692): 1 hour and This evening, each with
 * the time it brings the question back, then the days as chips and the time an hour ahead, with
 * "Snooze until 15:00" to confirm. The time is typed, to the minute, in the browser's own time
 * field, which phones open as their clock.
 */
function SnoozeTimes({
  now,
  clock,
  up,
  menuRef,
  onPick,
}: {
  now: Date;
  clock: ReturnType<typeof usePref<"clock">>[0];
  up: boolean;
  menuRef: React.Ref<HTMLDivElement>;
  onPick: (until: Date) => void;
}) {
  const days = pickDays(now).filter((d) => pickTimes(d, now).length > 0);
  // By date, not index: today leaves the list at 23:25 while the picker may be open.
  const [dayAt, setDayAt] = useState(() => days[0]?.getTime());
  const day = days.find((d) => d.getTime() === dayAt) ?? (days[0] as Date);
  const [time, setTime] = useState(() => hhmm(snoozeStart(day, now)));
  const until = time ? onDay(day, time) : undefined;
  const chosen = until && snoozeTakes(until, now) ? until : undefined;
  return (
    <div
      ref={menuRef}
      className={`t-small m-drop ${s.menu} ${up ? s.up : ""}`}
      role="dialog"
      aria-label="Snooze until"
    >
      {snoozePresets(now).map((p) => (
        <button key={p.label} type="button" className={s.item} onClick={() => onPick(p.until)}>
          {p.label}
          <span className={`t-meta ${s.when}`}>{snoozeTime(p.until, now, clock)}</span>
        </button>
      ))}
      <form
        className={s.pick}
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen) onPick(chosen);
        }}
      >
        <fieldset className={s.days}>
          <legend className="t-meta">Day</legend>
          {days.map((d) => (
            <button
              key={d.getTime()}
              type="button"
              className={`t-meta ${s.day}`}
              aria-pressed={d === day}
              onClick={() => {
                setDayAt(d.getTime());
                setTime(hhmm(snoozeStart(d, now)));
              }}
            >
              {dayLabel(d, now)}
            </button>
          ))}
        </fieldset>
        <label className={`t-meta ${s.timeLabel}`}>
          Time
          <input
            type="time"
            required
            className={`t-small ${s.time}`}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <button type="submit" className={`t-label ${ui.btn} ${ui.fill} ${s.go}`} disabled={!chosen}>
          {chosen ? `Snooze until ${snoozeTime(chosen, now, clock)}` : "Snooze"}
        </button>
      </form>
    </div>
  );
}
