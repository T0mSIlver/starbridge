"use client";

import { createContext, useContext, useState } from "react";
import { NOW } from "@/lib/fixtures";
import type { Decision } from "@/lib/types";

type Store = { items: Decision[]; answer: (id: string, value: string) => void };

const Ctx = createContext<Store | null>(null);

// Holds the decisions for the nav badge and the Inbox. Answers stay in memory
// until the web talks to the server (#8).
export function DecisionsProvider({
  initial,
  children,
}: {
  initial: Decision[];
  children: React.ReactNode;
}) {
  const [items, setItems] = useState(initial);
  const answer = (id: string, value: string) =>
    setItems((all) =>
      all.map((d) =>
        d.id === id
          ? { ...d, answer: { value, at: NOW.toISOString(), device: "This browser" } }
          : d,
      ),
    );
  return <Ctx.Provider value={{ items, answer }}>{children}</Ctx.Provider>;
}

export function useDecisions(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useDecisions outside DecisionsProvider");
  return store;
}
