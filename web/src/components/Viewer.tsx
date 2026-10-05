"use client";

import type { DecisionImage } from "@starbridge/protocol";
import { useEffect, useRef, useState } from "react";
import { imageSrc } from "@/lib/attachments";
import { Icon } from "./icons";
import s from "./Viewer.module.css";

type View = { scale: number; x: number; y: number };

/** The scale that fits the whole image in the box, never above its real pixels. */
function fit(img: DecisionImage, box: DOMRect): View {
  const scale = Math.min(box.width / img.width, box.height / img.height, 1);
  return {
    scale,
    x: (box.width - img.width * scale) / 2,
    y: (box.height - img.height * scale) / 2,
  };
}

/** Scales `v` by `k` around the point (px, py), between `min` and 8 times the real pixels. */
function zoom(v: View, k: number, px: number, py: number, min: number): View {
  const scale = Math.min(Math.max(v.scale * k, min), 8);
  const r = scale / v.scale;
  return { scale, x: px - (px - v.x) * r, y: py - (py - v.y) * r };
}

/**
 * A decision's images full screen in this tab (#170): wheel or pinch to zoom, drag to pan, double
 * click for real pixels, arrow keys between images, Escape to close.
 */
export function Viewer({
  images,
  start,
  onClose,
}: {
  images: DecisionImage[];
  start: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(start);
  const [view, setView] = useState<View>();
  const img = images[at] as DecisionImage;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const box = () => stage.current?.getBoundingClientRect() as DOMRect;
  const least = () => fit(img, box()).scale;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // Each image opens fitted.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refit only when the image changes
  useEffect(() => {
    setView(fit(img, box()));
  }, [at]);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    // A passive listener could not stop the page from zooming instead.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView(
        (v) =>
          v && zoom(v, Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top, least()),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const go = (by: number) => setAt((i) => (i + by + images.length) % images.length);
  const center = () => {
    const r = box();
    return [r.width / 2, r.height / 2] as const;
  };

  return (
    <dialog
      ref={dialog}
      className={s.viewer}
      aria-label={img.alt || "Image"}
      onClose={onClose}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === "ArrowRight" && images.length > 1) go(1);
        else if (k === "ArrowLeft" && images.length > 1) go(-1);
        else if (k === "+" || k === "=") setView((v) => v && zoom(v, 1.5, ...center(), least()));
        else if (k === "-") setView((v) => v && zoom(v, 1 / 1.5, ...center(), least()));
        else if (k === "0") setView(fit(img, box()));
        else return;
        e.preventDefault();
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer zoom and pan; the keys zoom too */}
      <div
        ref={stage}
        className={s.stage}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }}
        onPointerMove={(e) => {
          const ps = pointers.current;
          const was = ps.get(e.pointerId);
          if (!was) return;
          const others = [...ps.entries()].filter(([id]) => id !== e.pointerId);
          const now = { x: e.clientX, y: e.clientY };
          ps.set(e.pointerId, now);
          const r = box();
          const other = others[0]?.[1];
          if (other) {
            // Pinch: scale by the change in finger distance, around their midpoint.
            const k =
              Math.hypot(now.x - other.x, now.y - other.y) /
              Math.max(1, Math.hypot(was.x - other.x, was.y - other.y));
            const mx = (now.x + other.x) / 2 - r.left;
            const my = (now.y + other.y) / 2 - r.top;
            setView((v) => v && zoom(v, k, mx, my, least()));
          } else {
            setView((v) => v && { ...v, x: v.x + now.x - was.x, y: v.y + now.y - was.y });
          }
        }}
        onPointerUp={(e) => pointers.current.delete(e.pointerId)}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onDoubleClick={(e) => {
          const r = box();
          const fitted = fit(img, r);
          setView((v) =>
            !v || v.scale > fitted.scale * 1.01
              ? fitted
              : zoom(
                  v,
                  Math.max(1, fitted.scale * 2) / v.scale,
                  e.clientX - r.left,
                  e.clientY - r.top,
                  fitted.scale,
                ),
          );
        }}
      >
        {view && (
          // biome-ignore lint/performance/noImgElement: decrypted data, nothing for next/image to fetch
          <img
            className={s.img}
            src={imageSrc(img)}
            alt={img.alt ?? ""}
            width={img.width}
            height={img.height}
            draggable={false}
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          />
        )}
      </div>
      <div className={s.bar}>
        {images.length > 1 && (
          <>
            <button
              type="button"
              className={s.btn}
              aria-label="Previous image"
              onClick={() => go(-1)}
            >
              <Icon name="prev" size={20} />
            </button>
            <span className={`t-meta ${s.count}`}>
              {at + 1} / {images.length}
            </span>
            <button type="button" className={s.btn} aria-label="Next image" onClick={() => go(1)}>
              <Icon name="chev" size={20} />
            </button>
          </>
        )}
        <button
          type="button"
          className={`${s.btn} ${s.close}`}
          aria-label="Close"
          // biome-ignore lint/a11y/noAutofocus: the dialog's first stop is its way out
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" size={20} />
        </button>
      </div>
    </dialog>
  );
}
