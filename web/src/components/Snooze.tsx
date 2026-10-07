"use client";

import { useEffect, useRef, useState } from "react";
import { clockTime } from "@/lib/format";
import { usePref } from "@/lib/prefs";
import {
  dayLabel,
  pickDays,
  pickTimes,
  snoozePresets,
  snoozeStart,
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
 * "Snooze until 15:00" to confirm. Half hours in the Clock setting: the browser's own time field
 * writes hours its own way, unlike the rest of the page.
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
  const times = pickTimes(days[day] as Date, now);
  const [time, setTime] = useState(() => snoozeStart(days[0] as Date, now)?.getTime());
  const chosen = times.find((t) => t.getTime() === time) ?? snoozeStart(days[day] as Date, now);
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
                setTime(snoozeStart(d, now)?.getTime());
              }}
            >
              {dayLabel(d, now)}
            </button>
          ))}
        </fieldset>
        <label className={`t-meta ${s.timeLabel}`}>
          Time
          <select
            className={`t-small ${s.time}`}
            value={chosen?.getTime()}
            onChange={(e) => setTime(Number(e.target.value))}
          >
            {times.map((t) => (
              <option key={t.getTime()} value={t.getTime()}>
                {clockTime(t, clock)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={`t-label ${ui.btn} ${ui.fill} ${s.go}`} disabled={!chosen}>
          {chosen ? `Snooze until ${snoozeTime(chosen, now, clock)}` : "Snooze"}
        </button>
      </form>
    </div>
  );
}
