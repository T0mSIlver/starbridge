"use client";

import s from "./Resizer.module.css";

/**
 * A pane's draggable edge: drag it, or focus it and press the arrow keys; a double click goes
 * back to the default width. `width` is the pane's, which grows with `side`'s direction.
 */
export function Resizer({
  label,
  width,
  min,
  max,
  side,
  onChange,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  /** "left": the pane sits left of the edge, so dragging right widens it. */
  side: "left" | "right";
  onChange: (width: number | null) => void;
}) {
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));
  const sign = side === "left" ? 1 : -1;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={s.edge}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const w0 = width;
        const move = (m: PointerEvent) => onChange(clamp(w0 + sign * (m.clientX - x0)));
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      onDoubleClick={() => onChange(null)}
      onKeyDown={(e) => {
        const by = e.key === "ArrowRight" ? 16 : e.key === "ArrowLeft" ? -16 : 0;
        if (!by) return;
        e.preventDefault();
        onChange(clamp(width + sign * by));
      }}
    />
  );
}
