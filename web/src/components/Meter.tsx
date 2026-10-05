import type { CSSProperties } from "react";
import type { State } from "@/lib/quota";
import { bar, type QuotaSettings } from "@/lib/quotaSettings";
import type { QuotaWindow } from "@/lib/types";
import s from "./Meter.module.css";

/** The provider's lab colour from DESIGN.md, keyed by CodexBar's id; `fg3` for one it lacks. */
export function providerFill(provider: string): CSSProperties {
  const id = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { "--fill": `var(--provider-${id}, var(--fg3))` } as CSSProperties;
}

/**
 * A quota window's meter (DESIGN.md, "Rules"): the fill in the lab colour, a tick where a steady
 * pace would be now, workday gaps on weekly bars, and for a window that will run out, the use
 * projected before the reset hatched up to a red cap at the limit.
 */
export function Meter({
  provider,
  label,
  w,
  state,
  settings,
  now,
  className,
}: {
  provider: string;
  label: string;
  w: QuotaWindow;
  state: State;
  settings: QuotaSettings;
  now: Date;
  className?: string;
}) {
  const b = bar(w, settings, now);
  const out = state === "ran-out";
  const over = state === "out";
  const used = settings.showUsed;
  const percent = out ? (used ? 100 : 0) : b.percent;
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot draw the pace tick or the overrun
    <div
      className={`${s.meter} ${className ?? ""}`}
      style={providerFill(provider)}
      role="meter"
      aria-label={`${provider} ${label} ${b.word}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}% ${b.word}${b.steady !== null && !out ? `, steady pace ${b.steady}%` : ""}`}
    >
      <i className={s.track} />
      {percent > 0 && <i className={s.fill} style={{ width: `${percent}%` }} />}
      {over &&
        (used ? (
          <i className={s.over} style={{ left: `${percent}%`, right: 0 }} />
        ) : (
          <i className={s.eaten} style={{ left: 0, width: `${percent}%` }} />
        ))}
      {b.ticks.map((t) => (
        <i
          key={t}
          className={settings.ticks === "high-contrast" ? s.strong : s.gap}
          style={{ left: `${t}%` }}
        />
      ))}
      {(over || out) && <i className={`${s.cap} ${used ? s.end : s.start}`} />}
      {!out && b.steady !== null && (
        <i className={s.tick} style={{ left: `${Math.min(Math.max(b.steady, 0), 100)}%` }} />
      )}
    </div>
  );
}
