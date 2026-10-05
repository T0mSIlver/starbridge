"use client";

import { useMemo } from "react";
import { DEFAULT_SETTINGS } from "@/lib/quotaSettings";
import { sample } from "@/lib/sample";
import { type Store, StoreContext } from "./AppProvider";

const noop = async () => {};

/**
 * The app's store filled with the mockups' data, for product shots: answers go nowhere.
 * `landing` leaves out the permission prompt, which would top the list, and the lost run: the
 * landing page leads with questions.
 */
export function SampleProvider({
  landing = false,
  children,
}: {
  landing?: boolean;
  children: React.ReactNode;
}) {
  const store = useMemo<Store>(() => {
    const { devices, ...s } = sample();
    return {
      boot: { state: "loading" },
      ...s,
      ...(landing && {
        prompts: [],
        runs: { ...s.runs, items: s.runs.items.filter((i) => i.run.id !== "r3") },
      }),
      sampleDevices: devices,
      reload: noop,
      answer: noop,
      update: () => {},
      refreshQuotas: noop,
      quotaSettings: DEFAULT_SETTINGS,
      setQuotaSettings: () => {},
      answerPrompt: noop,
      loadPromptLog: noop,
      deviceName: (id) => id,
    };
  }, [landing]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
