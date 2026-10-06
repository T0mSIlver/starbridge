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
 * its first update, and the snoozed questions: the landing page leads with questions. `empty` is
 * a new account: no machine, nothing open.
 */
export function SampleProvider({
  landing = false,
  empty = false,
  noQuotas = false,
  children,
}: {
  landing?: boolean;
  empty?: boolean;
  /** No snapshot yet, as on a device that just joined (#661). */
  noQuotas?: boolean;
  children: React.ReactNode;
}) {
  const [quotaSettings, setQuotaSettings] = useState(DEFAULT_SETTINGS);
  // Snoozes given on the page, by question: the sample's own times until the owner snoozes one.
  const [snoozes, setSnoozes] = useState<Record<string, string>>({});
  const store = useMemo<Store>(() => {
    const { devices, ...s } = sample();
    const items = s.inbox.items.map((i) =>
      i.decision.id in snoozes ? { ...i, snoozedUntil: snoozes[i.decision.id] } : i,
    );
    return {
      boot: { state: "loading" },
      inboxLoaded: true,
      ...s,
      inbox: { ...s.inbox, items: landing ? items.filter((i) => !i.snoozedUntil) : items },
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
      sampleDevices: empty ? devices.filter((d) => d.role !== "machine") : devices,
      reload: noop,
      answer: noop,
      snooze: async (item, until) => setSnoozes((all) => ({ ...all, [item.decision.id]: until })),
      update: () => {},
      refreshQuotas: noop,
      askQuotas: () => new Promise((done) => setTimeout(done, 1500)),
      quotaSettings,
      setQuotaSettings,
      answerPrompt: noop,
      loadPromptLog: noop,
      deviceName: (id) => id,
    };
  }, [landing, empty, noQuotas, quotaSettings, snoozes]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
