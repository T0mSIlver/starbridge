"use client";

import { useEffect, useState } from "react";
import type { RecoveryState } from "@/lib/device";
import { dayAndTime } from "@/lib/format";
import { usePref } from "@/lib/prefs";
import { useApp } from "./AppProvider";
import b from "./PushBanner.module.css";
import ui from "./ui.module.css";

const load = () => import("@/lib/device");

/** A replacement of the recovery key made on another device (#348), shown once. */
export function RecoveryBanner() {
  const { boot } = useApp();
  const ctx = boot.state === "ready" ? boot.ctx : undefined;
  const [state, setState] = useState<RecoveryState>();
  const [clock] = usePref("clock");
  useEffect(() => {
    if (ctx)
      load()
        .then((d) => d.recoveryState(ctx))
        .then(setState)
        .catch(() => {});
  }, [ctx]);
  if (!ctx || !state) return null;
  const { notice } = state;
  if (notice)
    return (
      <div className={`t-meta ${b.banner}`} role="status">
        <span>
          Recovery key replaced on {notice.by}, {dayAndTime(notice.at, clock)}.
        </span>
        <button
          type="button"
          className={`t-meta ${ui.btn} ${ui.sm}`}
          onClick={async () => {
            await (await load()).dismissRecoveryNotice(ctx, notice.seq);
            setState({ ...state, notice: undefined });
          }}
        >
          OK
        </button>
      </div>
    );
  return null;
}
