"use client";

import { createContext, useContext, useState } from "react";
import { NOW } from "@/lib/now";
import type { InboxItem } from "@/lib/types";

/** A tap on an option, or typed text when the decision has none. */
export type Reply = { choice: string } | { text: string };

type Store = { items: InboxItem[]; answer: (decisionId: string, reply: Reply) => void };

const Ctx = createContext<Store | null>(null);

// Holds the inbox for the nav badge and the Inbox. Answers stay in memory
// until the web talks to the server (#8).
export function DecisionsProvider({
  initial,
  children,
}: {
  initial: InboxItem[];
  children: React.ReactNode;
}) {
  const [items, setItems] = useState(initial);
  const answer = (decisionId: string, reply: Reply) =>
    setItems((all) =>
      all.map((item) =>
        item.decision.id === decisionId
          ? {
              ...item,
              answer: {
                v: 1,
                id: `a-${decisionId}`,
                decisionId,
                // The asking machine's id comes with the sealed decision in #8.
                to: item.decision.source.machine,
                answeredAt: NOW.toISOString(),
                ...reply,
              },
              answeredBy: "This browser",
            }
          : item,
      ),
    );
  return <Ctx.Provider value={{ items, answer }}>{children}</Ctx.Provider>;
}

export function useDecisions(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useDecisions outside DecisionsProvider");
  return store;
}
