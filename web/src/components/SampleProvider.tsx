"use client";

import { useMemo } from "react";
import { DEFAULT_SETTINGS } from "@/lib/quotaSettings";
import { sample } from "@/lib/sample";
import { type Store, StoreContext } from "./AppProvider";

const noop = async () => {};

/** The app's store filled with the mockups' data, for product shots: answers go nowhere. */
export function SampleProvider({ children }: { children: React.ReactNode }) {
  const store = useMemo<Store>(() => {
    const s = sample();
    return {
      boot: { state: "loading" },
      ...s,
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
  }, []);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}
