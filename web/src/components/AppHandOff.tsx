"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import s from "./Setup.module.css";
import ui from "./ui.module.css";

const POLL_MS = 2_000;
/** As long as the server keeps the sign-in (APP_SIGN_IN_MS). */
const GIVE_UP_MS = 10 * 60_000;

/**
 * On the page that passes an app's sign-in on (#943): this browser runs where the app does, so
 * once the server says the app reached this browser's own account, the page offers to turn off
 * this browser's notifications, which the app now shows. Only this browser's: the offer turns off
 * nothing elsewhere, and a browser that holds no device of the account, or has notifications
 * off, never sees it.
 */
export function AppHandOff({ state }: { state: string }) {
  const [phase, setPhase] = useState<"waiting" | "ask" | "off" | "kept">("waiting");
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      if (stop || Date.now() - started > GIVE_UP_MS) return;
      try {
        if (await api.appSignedIn(state)) {
          if (!stop) setPhase("ask");
          return;
        }
      } catch (e) {
        // No device of the account here, or a server without the route: nothing to offer.
        if (e instanceof ApiError && e.status < 500 && e.status !== 429) return;
      }
      timer = setTimeout(poll, POLL_MS);
    };
    import("@/lib/push")
      .then((p) => p.pushState())
      .then((push) => {
        if (push === "on") poll();
      });
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [state]);
  if (phase === "waiting" || phase === "kept") return null;
  if (phase === "off")
    return (
      <p className={`t-small ${s.lede}`} role="status">
        This browser no longer notifies you. Settings → Notifications turns it back on.
      </p>
    );
  return (
    <section aria-label="This browser’s notifications">
      <p className={`t-small ${s.lede}`}>
        The Starbridge app is now signed in on this computer and notifies you here too. Turn off
        this browser&apos;s notifications, so each question arrives once?
      </p>
      <div className={s.offerActions}>
        <button
          type="button"
          className={`t-label ${ui.btn} ${ui.lg}`}
          onClick={async () => {
            setError(undefined);
            try {
              await (await import("@/lib/push")).disablePush();
              await (await import("@/lib/notify")).report();
              setPhase("off");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Turn off in this browser
        </button>
        <button
          type="button"
          className={`t-label ${ui.btn} ${ui.lg} ${ui.ghost}`}
          onClick={() => setPhase("kept")}
        >
          Keep both
        </button>
      </div>
      {error && <p className={`t-meta ${s.error}`}>{error}</p>}
    </section>
  );
}
