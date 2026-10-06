"use client";

import { useMemo, useState } from "react";
import { DEFAULT_SETTINGS } from "@/lib/quotaSettings";
import { sample } from "@/lib/sample";
import { type Store, StoreContext } from "./AppProvider";

const noop = async () => {};

/**
 * The app's store filled with the sample data (lib/sample.ts), for product shots: answers go
 * nowhere, and quota settings last for the page.
 * `landing` leaves out the permission prompt, which would top the list, and the run killed before
 * its first update: the landing page leads with questions. `empty` is a new account: no machine,
 * nothing open.
 */
export function SampleProvider({
  landing = false,
  empty = false,
  noQuotas = false,
  quiet = false,
  children,
}: {
  landing?: boolean;
  empty?: boolean;
  /** No snapshot yet, as on a device that just joined (#661). */
  noQuotas?: boolean;
  /** Nothing open, History only: the quiet inbox (#662). */
  quiet?: boolean;
  children: React.ReactNode;
}) {
  const [quotaSettings, setQuotaSettings] = useState(DEFAULT_SETTINGS);
  const store = useMemo<Store>(() => {
    const { devices, ...s } = sample();
    return {
      boot: { state: "loading" },
      inboxLoaded: true,
      ...s,
      ...(landing && {
        prompts: [],
        runs: { ...s.runs, items: s.runs.items.filter((i) => i.run.id !== "r3") },
      }),
      ...(empty && {
        inbox: { items: [], rejected: [] },
        prompts: [],
        runs: { items: [], rejected: [] },
        quotas: undefined,
      }),
      ...(noQuotas && { quotas: { cards: [], errors: [], rejected: [] } }),
      ...(quiet && {
        inbox: { ...s.inbox, items: s.inbox.items.filter((i) => i.answeredAt) },
        prompts: [],
        runs: { ...s.runs, items: [] },
      }),
      sampleDevices: empty ? devices.filter((d) => d.role !== "machine") : devices,
      reload: noop,
      answer: noop,
      update: () => {},
      refreshQuotas: noop,
      askQuotas: () => new Promise((done) => setTimeout(done, 1500)),
      quotaSettings,
      setQuotaSettings,
      answerPrompt: noop,
      loadPromptLog: noop,
      deviceName: (id) => id,
    };
  }, [landing, empty, noQuotas, quiet, quotaSettings]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
