"use client";

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import s from "./Reorder.module.css";

type Drag = {
  id: string;
  from: number;
  to: number;
  /** How far the dragged item sits from its place, in px. */
  dy: number;
  /** Released: the item glides into its new place, then the order changes. */
  settling: boolean;
  tops: number[];
  heights: number[];
  /** From the top of one item to the top of the next, less the item: the list's gap. */
  gap: number;
  y0: number;
  scroll0: number;
};

/** Closer than this to the window's top or bottom edge, a drag scrolls the page. */
const EDGE = 48;

const duration = (token: string) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v.endsWith("ms") ? Number.parseFloat(v) : Number.parseFloat(v) * 1000 || 0;
};
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A list reordered by its handles, live: the dragged item follows the pointer (mouse, pen or
 * touch) and the items it passes slide aside at `motion.state`; on release it settles into its
 * place at the same `motion.state`, so it lands as the others do, then `onMove` commits the order. A focused handle moves its item with
 * the arrow keys, Home and End, and a live region says where it went. Escape cancels a drag.
 * Items before `first` stay put and take no drop (the quota windows that lead while running
 * out); `locked` items keep their handle off, and no item crosses them. A drag still on when the list
 * unmounts is torn down. DESIGN.md, "Motion and states".
 */
export function useReorder({
  ids,
  name,
  onMove,
  first = 0,
  locked,
}: {
  ids: string[];
  name: (id: string) => string;
  onMove: (id: string, to: number) => void;
  first?: number;
  locked?: (id: string) => boolean;
}) {
  const [drag, setDrag] = useState<Drag>();
  const [said, setSaid] = useState("");
  const items = useRef(new Map<string, HTMLElement>());
  const handles = useRef(new Map<string, HTMLElement>());
  const live = useRef<Drag | undefined>(undefined);
  const refocus = useRef<string | undefined>(undefined);
  // Ends the drag in progress: its frame loop, listeners and settling timer.
  const stop = useRef<(() => void) | undefined>(undefined);
  live.current = drag;
  useEffect(() => () => stop.current?.(), []);

  // The moved item's handle keeps focus across the reorder, which moves its DOM node.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    handles.current.get(refocus.current)?.focus();
    refocus.current = undefined;
  });

  const commit = useCallback(
    (id: string, to: number, from: number) => {
      setDrag(undefined);
      if (to === from) return;
      refocus.current = id;
      onMove(id, to);
      setSaid(`${name(id)} moved to ${to + 1} of ${ids.length}`);
    },
    [ids.length, name, onMove],
  );

  /** Where the item at `from` may go: past `first`, and never across a locked item. */
  const range = (from: number): [number, number] => {
    let lo = Math.max(first, 0);
    let hi = ids.length - 1;
    ids.forEach((x, i) => {
      if (!locked?.(x)) return;
      if (i < from) lo = Math.max(lo, i + 1);
      if (i > from) hi = Math.min(hi, i - 1);
    });
    return [lo, hi];
  };

  const start = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || live.current) return;
    const from = ids.indexOf(id);
    if (from < first || locked?.(id)) return;
    const [lo, hi] = range(from);
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rects = ids.map((x) => items.current.get(x)?.getBoundingClientRect());
    if (rects.some((r) => !r)) return;
    const tops = rects.map((r) => (r as DOMRect).top);
    const heights = rects.map((r) => (r as DOMRect).height);
    const gap =
      ids.length > 1 ? Math.max(0, (tops[1] ?? 0) - (tops[0] ?? 0) - (heights[0] ?? 0)) : 0;
    let y = e.clientY;
    let frame = 0;
    const d: Drag = {
      id,
      from,
      to: from,
      dy: 0,
      settling: false,
      tops,
      heights,
      gap,
      y0: e.clientY,
      scroll0: window.scrollY,
    };
    setDrag(d);

    const place = () => {
      const cur = live.current;
      if (!cur || cur.settling) return;
      const dy = y - d.y0 + (window.scrollY - d.scroll0);
      const centre = (tops[from] ?? 0) + (heights[from] ?? 0) / 2 + dy;
      const mid = (i: number) => (tops[i] ?? 0) + (heights[i] ?? 0) / 2;
      let to = from;
      while (to < hi && centre > mid(to + 1)) to++;
      while (to > lo && centre < mid(to - 1)) to--;
      setDrag({ ...cur, dy, to });
    };
    const scroll = () => {
      const by =
        y < EDGE ? -(EDGE - y) / 3 : y > innerHeight - EDGE ? (y - innerHeight + EDGE) / 3 : 0;
      if (by) {
        window.scrollBy(0, by);
        place();
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);

    const end = (cancel: boolean) => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("keydown", key);
      stop.current = undefined;
      const cur = live.current;
      if (!cur) return;
      if (cancel || cur.to === cur.from || reduced()) {
        commit(cur.id, cancel ? cur.from : cur.to, cur.from);
        return;
      }
      // Glide into the gap the others opened, then commit with no transition, so nothing jumps.
      const { to } = cur;
      const at =
        to > from
          ? (tops[to] ?? 0) + (heights[to] ?? 0) - (tops[from] ?? 0) - (heights[from] ?? 0)
          : (tops[to] ?? 0) - (tops[from] ?? 0);
      setDrag({ ...cur, dy: at, settling: true });
      // The rows it passed may still be sliding: land with them, then commit.
      const timer = setTimeout(() => {
        stop.current = undefined;
        commit(cur.id, to, from);
      }, duration("--t-state"));
      stop.current = () => clearTimeout(timer);
    };
    const move = (m: PointerEvent) => {
      y = m.clientY;
      place();
    };
    const up = () => end(false);
    const cancelled = () => end(true);
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      end(true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancelled);
    window.addEventListener("keydown", key);
    stop.current = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("keydown", key);
    };
  };

  const keyMove = (id: string, e: React.KeyboardEvent) => {
    const from = ids.indexOf(id);
    const last = ids.length - 1;
    const to =
      e.key === "ArrowUp"
        ? from - 1
        : e.key === "ArrowDown"
          ? from + 1
          : e.key === "Home"
            ? first
            : e.key === "End"
              ? last
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    if (live.current || from < first || locked?.(id)) return;
    const [lo, hi] = range(from);
    commit(id, Math.max(lo, Math.min(hi, to)), from);
  };

  /** Where an item stands while a drag is on: the dragged one under the pointer, others aside. */
  const shift = (i: number): number => {
    if (!drag) return 0;
    if (i === drag.from) return drag.dy;
    const by = (drag.heights[drag.from] ?? 0) + drag.gap;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -by;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return by;
    return 0;
  };

  return {
    /** The list's own props: while a drag is on, its items slide. */
    list: { className: drag ? s.active : undefined },
    item: (id: string) => {
      const i = ids.indexOf(id);
      const dy = shift(i);
      const dragged = drag?.id === id;
      return {
        ref: (el: HTMLElement | null) => {
          if (el) items.current.set(id, el);
          else items.current.delete(id);
        },
        className: dragged ? `${s.dragged} ${drag?.settling ? s.settling : ""}` : s.item,
        style: dy ? ({ transform: `translateY(${dy}px)` } as CSSProperties) : undefined,
      };
    },
    handle: (id: string) => {
      const fixed = ids.indexOf(id) < first || !!locked?.(id);
      return {
        ref: (el: HTMLElement | null) => {
          if (el) handles.current.set(id, el);
          else handles.current.delete(id);
        },
        className: s.handle,
        "aria-label": `Move ${name(id)}`,
        "aria-keyshortcuts": "ArrowUp ArrowDown Home End",
        "aria-disabled": fixed || undefined,
        tabIndex: fixed ? -1 : undefined,
        onPointerDown: (e: React.PointerEvent<HTMLElement>) => start(id, e),
        onKeyDown: (e: React.KeyboardEvent) => keyMove(id, e),
      };
    },
    /** A polite live region's text: where the last move put its item. */
    said,
  };
}
