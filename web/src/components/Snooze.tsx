"use client";

import { useEffect, useRef, useState } from "react";
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
import s from "./Snooze.module.css";
import ui from "./ui.module.css";

/**
 * "Snooze" and its times (#571, #699), up to 7 days ahead. Quiet, as Reply: putting a question off
 * is never the default.
 */
export function SnoozeMenu({
  label,
  disabled,
  className,
  onSnooze,
}: {
  label: string;
  disabled?: boolean;
  /** The trigger's classes, so it matches the quiet buttons beside it. */
  className: string;
  onSnooze: (until: Date) => void;
}) {
  const [clock] = usePref("clock");
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

  const now = new Date();
  const pick = (until: Date) => {
    setOpen(false);
    onSnooze(until);
  };
  return (
    <div className={s.snooze} ref={ref}>
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && <SnoozeTimes now={now} clock={clock} onPick={pick} />}
    </div>
  );
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
  onPick,
}: {
  now: Date;
  clock: ReturnType<typeof usePref<"clock">>[0];
  onPick: (until: Date) => void;
}) {
  const days = pickDays(now).filter((d) => pickTimes(d, now).length > 0);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState(() => hhmm(snoozeStart(days[0] as Date, now)));
  const until = time ? onDay(days[day] as Date, time) : undefined;
  const chosen = until && snoozeTakes(until, now) ? until : undefined;
  return (
    <div className={`t-small m-drop ${s.menu}`} role="dialog" aria-label="Snooze until">
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
          {days.map((d, i) => (
            <button
              key={d.getTime()}
              type="button"
              className={`t-meta ${s.day}`}
              aria-pressed={i === day}
              onClick={() => {
                setDay(i);
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
