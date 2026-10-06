"use client";

import { useEffect, useRef, useState } from "react";
import { clockTime } from "@/lib/format";
import { usePref } from "@/lib/prefs";
import { dayLabel, pickDays, pickTimes, snoozePresets, snoozeTime } from "@/lib/snooze";
import s from "./Snooze.module.css";
import ui from "./ui.module.css";

/**
 * "Snooze" and its times (#571): 1 hour, This evening, Tomorrow morning, or a picked time up to 7
 * days ahead. Quiet, as Reply: putting a question off is never the default.
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
  const [picking, setPicking] = useState(false);
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
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setPicking(false);
          setOpen(!open);
        }}
      >
        {label}
      </button>
      {open && (
        <div className={`t-small m-drop ${s.menu}`} role="menu" aria-label="Snooze until">
          {snoozePresets(now).map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              className={s.item}
              onClick={() => pick(p.until)}
            >
              {p.label}
              <span className={`t-meta ${s.when}`}>
                {snoozeTime(p.until, now, clock, p.label === "Tomorrow morning")}
              </span>
            </button>
          ))}
          {picking ? (
            <PickTime now={now} clock={clock} onPick={pick} />
          ) : (
            <button
              type="button"
              role="menuitem"
              className={s.item}
              onClick={() => setPicking(true)}
            >
              Pick a time
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pick a time (#571): a day out of the next 8, then a half hour of it, in the Clock setting.
 * The browser's own date and time field writes dates and hours its own way, unlike the menu.
 */
function PickTime({
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
  // An hour from now today, else the morning: the presets' rhythm.
  const first = (list: Date[], i: number) =>
    (i === 0
      ? list.find((t) => t.getTime() >= now.getTime() + 60 * 60_000)
      : list.find((t) => t.getHours() === 9)) ?? list[0];
  const [time, setTime] = useState(() => first(times, 0)?.getTime());
  const chosen = times.find((t) => t.getTime() === time) ?? first(times, day);
  return (
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
              setTime(first(pickTimes(d, now), i)?.getTime());
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
      <button type="submit" className={`t-meta ${ui.btn} ${ui.sm} ${s.go}`} disabled={!chosen}>
        Snooze
      </button>
    </form>
  );
}
