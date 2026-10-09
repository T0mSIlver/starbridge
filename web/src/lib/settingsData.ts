// What the Settings page shows that the page does not already hold: loaded together, so the page
// lays out once instead of growing as each part arrives (#937), and kept for the next visit.
import { api } from "./api";
import type { Ctx, RecoveryState } from "./device";
import type { PushState } from "./push";
import type { Device } from "./types";

export type SettingsData = {
  push: PushState;
  /** The account's push hold, or undefined on a server without the setting. */
  pushHold?: number;
  /** Undefined without a device, as on the sample pages. */
  devices?: Device[];
  recovery?: RecoveryState;
};

let kept: { account?: string; data: SettingsData } | undefined;
let loading: { account?: string; data: Promise<SettingsData> } | undefined;

/** The last load for this account, to show at once while a new one runs. */
export function keptSettingsData(ctx: Ctx | undefined): SettingsData | undefined {
  return kept && kept.account === ctx?.account ? kept.data : undefined;
}

export function loadSettingsData(ctx: Ctx | undefined): Promise<SettingsData> {
  if (loading && loading.account === ctx?.account) return loading.data;
  const account = ctx?.account;
  const data = (async () => {
    const [push, pushHold, own] = await Promise.all([
      import("./push").then((p) => p.pushState()),
      api.settings().then(
        (s) => s.pushHold,
        () => undefined,
      ),
      ctx
        ? import("./device").then(async (d) => ({
            devices: d.devices(ctx),
            recovery: await d.recoveryState(ctx).catch(() => undefined),
          }))
        : {},
    ]);
    const got: SettingsData = { push, pushHold, ...own };
    kept = { account, data: got };
    return got;
  })().finally(() => {
    if (loading?.data === data) loading = undefined;
  });
  loading = { account, data };
  return data;
}
