"use client";

import { useEffect, useState } from "react";
import type { PushState } from "@/lib/push";
import ui from "./ui.module.css";

/** Offers Web Push until it is on; says so when the browser blocks it or needs the app installed. */
export function PushBanner() {
  const [state, setState] = useState<PushState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    import("@/lib/push").then((p) => p.pushState()).then(setState);
  }, []);
  if (state === undefined || state === "on" || state === "unsupported") return null;
  if (state === "install")
    return (
      <p className={ui.notice} style={{ marginBottom: "var(--s4)" }} data-testid="install-hint">
        To get notifications here, tap Share, then Add to Home Screen, and open Starbridge from
        there. The Home Screen app keeps its own keys, so it joins as a new device.
      </p>
    );
  if (state === "denied")
    return (
      <p className={ui.notice} style={{ marginBottom: "var(--s4)" }}>
        Notifications are blocked for this site in the browser&apos;s settings.
      </p>
    );
  return (
    <div
      className={ui.notice}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s3)",
        marginBottom: "var(--s4)",
      }}
    >
      <span>Get a notification when an agent needs you.</span>
      <button
        type="button"
        className={ui.button}
        onClick={async () => {
          setError(undefined);
          try {
            setState(await (await import("@/lib/push")).enablePush());
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        Turn on notifications
      </button>
      {error && <span className={ui.error}>{error}</span>}
    </div>
  );
}
