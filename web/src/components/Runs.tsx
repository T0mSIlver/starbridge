"use client";

import { useEffect, useState } from "react";
import { duration, progressText, type RunState, runState, shownRuns } from "@/lib/runs";
import type { RunItem } from "@/lib/types";
import { useApp } from "./AppProvider";
import s from "./Runs.module.css";
import ui from "./ui.module.css";

/** Ticks every second while something runs, so the time elapsed moves. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** Commands the owner's rules name, as agents report them with `starbridge run`. */
export function Runs() {
  const { runs } = useApp();
  const items = runs?.items ?? [];
  // Lost runs stay a day on the server; only running ones need the clock.
  const live = items.some((i) => runState(i.run, Date.now()) === "running");
  const now = useNow(live);
  const shown = shownRuns(items, now);
  if (shown.length === 0) return null;
  return (
    <section aria-labelledby="runs-head" className={s.runs}>
      <h2 id="runs-head" className={`t-label ${s.head}`}>
        Runs
      </h2>
      <ul className={ui.list}>
        {shown.map((i) => (
          <li key={i.run.id}>
            <RunCard item={i} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function outcome(r: RunItem["run"], state: RunState, now: number): string {
  const took = duration(Date.parse(r.exit?.at ?? r.at) - Date.parse(r.startedAt));
  switch (state) {
    case "passed":
      return `Passed in ${took}`;
    case "failed":
      return `Failed, exit ${r.exit?.code}, after ${took}`;
    case "lost":
      return `No news for ${duration(now - Date.parse(r.at))}`;
    default:
      return duration(now - Date.parse(r.startedAt));
  }
}

export function RunCard({ item, now }: { item: RunItem; now: number }) {
  const { run: r, machine } = item;
  const state = runState(r, now);
  const p = r.progress;
  const fill = p ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <article className={`${ui.card} ${s.card}`} aria-label={r.title}>
      <div className={s.top}>
        <h3 className={`t-action ${s.title}`}>{r.title}</h3>
        <span className={`t-label ${s.word} ${s[state]}`}>{outcome(r, state, now)}</span>
      </div>
      <p className={`t-small ${s.reason}`}>{r.reason}</p>
      {state === "running" && (
        <div
          className={s.bar}
          role="progressbar"
          aria-label={`${r.title} progress`}
          {...(p
            ? { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": fill }
            : { "aria-busy": true })}
        >
          {p ? (
            <>
              {fill > 0 && <span className={s.fill} style={{ flexBasis: `${fill}%` }} />}
              {fill < 100 && <span className={s.rest} />}
            </>
          ) : (
            <span className={s.indeterminate} />
          )}
        </div>
      )}
      <p className={`t-machine ${s.source}`}>
        <span>
          {[machine, r.source.sessionTitle || r.source.project].filter(Boolean).join(" · ")}
        </span>
        {state === "running" && p && <span className={s.progress}>{progressText(p)}</span>}
      </p>
    </article>
  );
}
