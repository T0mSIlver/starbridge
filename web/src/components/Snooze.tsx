"use client";

import { useEffect, useRef, useState } from "react";
import { usePref } from "@/lib/prefs";
import { SNOOZE_MAX_MS, snoozeAllowed, snoozePresets, snoozeTime } from "@/lib/snooze";
import s from "./Snooze.module.css";
import ui from "./ui.module.css";

/** `datetime-local`'s value for `d`, in this device's zone. */
const local = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

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
  const [picked, setPicked] = useState("");
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
  const pickedAt = picked ? new Date(picked) : undefined;
  const pickedOk = pickedAt !== undefined && snoozeAllowed(pickedAt, new Date());
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
          setPicked(local(new Date(now.getTime() + 2 * 60 * 60_000)));
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
              <span className={`t-meta ${s.when}`}>{snoozeTime(p.until, now, clock, p.label === "Tomorrow morning")}</span>
            </button>
          ))}
          {picking ? (
            <form
              className={s.pick}
              onSubmit={(e) => {
                e.preventDefault();
                if (pickedAt && pickedOk) pick(pickedAt);
              }}
            >
              <label className="sr-only" htmlFor="snooze-at">
                Snooze until
              </label>
              <input
                id="snooze-at"
                type="datetime-local"
                className={`t-small ${ui.input} ${s.input}`}
                value={picked}
                min={local(now)}
                max={local(new Date(now.getTime() + SNOOZE_MAX_MS))}
                // biome-ignore lint/a11y/noAutofocus: opened by Pick a time, to set it at once
                autoFocus
                onChange={(e) => setPicked(e.target.value)}
              />
              <button
                type="submit"
                className={`t-meta ${ui.btn} ${ui.sm} ${s.go}`}
                disabled={!pickedOk}
              >
                Snooze
              </button>
            </form>
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
