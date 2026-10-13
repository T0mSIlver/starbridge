"use client";

import { useEffect, useState } from "react";
import { type DesktopUpdateSettings, type DesktopUpdateStatus, desktop } from "@/lib/desktop";
import { Icon, type IconName } from "./icons";
import s from "./UpdateButton.module.css";

/** The bridge takes one listener; the rail and Settings both hear it. */
const changes = new EventTarget();
desktop?.onUpdate?.(() => changes.dispatchEvent(new Event("change")));

type Updates = { status: DesktopUpdateStatus; settings: DesktopUpdateSettings };

function read(): Updates | undefined {
  const status = desktop?.updateStatus?.();
  const settings = desktop?.updateSettings?.();
  return status && settings ? { status, settings } : undefined;
}

/**
 * The desktop app's update, its status and settings (#1398); undefined in a browser and in an app
 * that runs no updater, which shows none of it.
 */
export function useDesktopUpdates(): Updates | undefined {
  // Read once mounted: the server renders the rail without it.
  const [state, setState] = useState<Updates>();
  useEffect(() => {
    const change = () => setState(read());
    change();
    changes.addEventListener("change", change);
    return () => changes.removeEventListener("change", change);
  }, []);
  return state;
}

/** What the button says and does in each state; nothing while idle or checking. */
function face(
  u: DesktopUpdateStatus,
): { label: string; icon: IconName; dot?: boolean; act?: "check" | "download" | "install" } | null {
  switch (u.state) {
    case "available":
      return { label: "Update available", icon: "download", dot: true, act: "download" };
    case "downloading":
      return { label: `Downloading ${u.percent}%`, icon: "download" };
    case "ready":
      return { label: "Restart to update", icon: "refresh", dot: true, act: "install" };
    case "error":
      return { label: "Update failed", icon: "download", act: "check" };
    default:
      return null;
  }
}

/** At the foot of the rail, as T3 Code has it: an update found, downloading, or ready. */
export function UpdateButton() {
  const updates = useDesktopUpdates();
  const f = updates && face(updates.status);
  if (!f || !updates) return null;
  const { status } = updates;
  const title =
    status.state === "error"
      ? status.message
      : "version" in status
        ? `Starbridge ${status.version}`
        : undefined;
  return (
    <button
      type="button"
      className={`t-small ${s.button}`}
      title={title}
      disabled={!f.act}
      onClick={() => f.act && desktop?.updateAction?.(f.act)}
    >
      <span className={s.icon}>
        <Icon name={f.icon} size={18} />
        {f.dot && <span className={s.dot} aria-hidden="true" />}
      </span>
      {f.label}
    </button>
  );
}
