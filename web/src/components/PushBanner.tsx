"use client";

import { useEffect, useRef, useState } from "react";
import { usePref } from "@/lib/prefs";
import type { PushState } from "@/lib/push";
import { useApp } from "./AppProvider";
import b from "./PushBanner.module.css";
import ui from "./ui.module.css";

/** Offers Web Push until it is on; says so when the browser blocks it or needs the app installed. */
export function PushBanner() {
  const ready = useApp().boot.state === "ready";
  const [state, setState] = useState<PushState>();
  const [error, setError] = useState<string>();
  // The owner turned them off in Settings (#943): no banner asks again.
  const [off] = usePref("pushOff");
  // Stops waiting for an answer the browser's prompt has yet to give (#1030).
  const waiting = useRef<() => void>(undefined);
  useEffect(() => {
    import("@/lib/push").then((p) => p.pushState()).then(setState);
    return () => waiting.current?.();
  }, []);
  if (!ready || state === undefined || state === "on" || state === "unsupported") return null;
  if (off && state === "off") return null;
  if (state === "install")
    return (
      <p className={`t-meta ${b.banner}`} data-testid="install-hint">
        To get notifications here, tap Share, then Add to Home Screen, and open Starbridge from
        there. The Home Screen app keeps its own keys, so it joins as a new device.
      </p>
    );
  if (state === "denied")
    return (
      <p className={`t-meta ${b.banner}`}>
        Notifications are blocked for this site in the browser&apos;s settings.
      </p>
    );
  return (
    <div className={`t-meta ${b.banner}`}>
      <span>Get a notification when an agent needs you.</span>
      <button
        type="button"
        className={`t-meta ${ui.btn} ${ui.sm}`}
        onClick={async () => {
          waiting.current?.();
          setError(undefined);
          const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
          try {
            const push = await import("@/lib/push");
            const next = await push.enablePush();
            setState(next);
            const notify = await import("@/lib/notify");
            notify.report();
            if (next === "off")
              waiting.current = push.finishOnAnswer((s) => {
                setState(s);
                notify.report();
              }, fail);
          } catch (e) {
            fail(e);
          }
        }}
      >
        Turn on notifications
      </button>
      {error && <span className={b.error}>{error}</span>}
    </div>
  );
}
