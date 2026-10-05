"use client";

import { useEffect } from "react";

/** Makes each code block's Copy button copy its code (lib/docs.ts renders them). */
export function CopyCode() {
  useEffect(() => {
    const onClick = async (e: MouseEvent) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
      const code = button?.parentElement?.querySelector("code")?.textContent;
      if (!button || code == null) return;
      try {
        await navigator.clipboard.writeText(code);
        button.dataset.copied = "";
        setTimeout(() => delete button.dataset.copied, 1500);
      } catch {}
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
