"use client";

import { PRESENCE_INPUT_MS } from "@starbridge/protocol";
import { useEffect } from "react";
import { type DesktopScreen, desktop } from "./desktop";
import { PRESENCE_EVENTS } from "./presence";

/** How often a page nobody looks at asks whether the server runs a new build. */
const CHECK_MS = 5 * 60_000;

const build = () =>
  fetch("/build", { cache: "no-store" }).then(
    (r) => (r.ok ? r.text() : null),
    () => null,
  );

/** The desktop app's window says whether it is on screen; the page's visibility does not there. */
const hidden = () => (desktop?.shown ? !desktop.shown() : document.visibilityState === "hidden");

export type Looks = {
  hidden: boolean;
  /** The desktop app's reading of the Mac (#945); undefined in a browser. */
  screen: DesktopScreen | null | undefined;
  /** Milliseconds since the last input in this page (presence's events). */
  sinceInput: number;
  /** A field has the focus, or a dialog is open. */
  editing: boolean;
};

/**
 * Whether nobody looks at the page: hidden, or, in the desktop app, a window shown on a Mac that is
 * locked or has had no input for a minute, with no field focused or dialog open (#1811). The Mac's
 * reading comes every 10 s, so the page's own input counts too.
 */
export function unwatched(l: Looks): boolean {
  if (l.hidden) return true;
  if (!l.screen || l.editing || l.sinceInput < PRESENCE_INPUT_MS) return false;
  return l.screen.away || (l.screen.idleMs ?? 0) >= PRESENCE_INPUT_MS;
}

const editing = () =>
  !!document.querySelector("dialog[open]") ||
  !!document.activeElement?.closest("input, textarea, select, [contenteditable]");

/**
 * Loads a new deploy while nobody looks. A page of an older build reloads in full on its next
 * navigation that reaches the server: a blank window for up to a second in the desktop app, which
 * stays open for days. So a page nobody looks at that finds a new build reloads then, unless `busy`.
 */
export function useFreshBuild(busy: () => boolean): void {
  useEffect(() => {
    // The build that served this page (app/layout.tsx).
    const own = document.querySelector<HTMLMetaElement>('meta[name="starbridge-build"]')?.content;
    if (!own) return;
    let inputAt = Date.now();
    const onInput = () => {
      inputAt = Date.now();
    };
    const away = () =>
      unwatched({
        hidden: hidden(),
        screen: desktop?.screen?.(),
        sinceInput: Date.now() - inputAt,
        editing: editing(),
      });
    let timer: ReturnType<typeof setInterval> | undefined;
    const check = async () => {
      if (!away() || busy()) return;
      const now = await build();
      if (now && now !== own && away() && !busy()) location.reload();
    };
    const onChange = () => {
      clearInterval(timer);
      // A shown desktop window keeps checking, for the minutes the Mac sits idle.
      if (!hidden() && !desktop?.screen) return;
      check();
      timer = setInterval(check, CHECK_MS);
    };
    // Also when it loads hidden: an app opened at login, or after this very reload.
    onChange();
    for (const e of PRESENCE_EVENTS)
      window.addEventListener(e, onInput, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onChange);
    desktop?.onShown?.(onChange);
    return () => {
      clearInterval(timer);
      for (const e of PRESENCE_EVENTS) window.removeEventListener(e, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onChange);
      desktop?.onShown?.(null);
    };
  }, [busy]);
}
