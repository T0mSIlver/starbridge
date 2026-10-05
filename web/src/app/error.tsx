"use client";

import { useEffect } from "react";
import { FirstRunPage } from "@/components/Setup";
import ui from "@/components/ui.module.css";

/** What a page shows when it throws while rendering. */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => console.error(error), [error]);
  return (
    <FirstRunPage>
      <h1 className="t-heading">Something went wrong</h1>
      <p className={`t-snippet ${ui.faint}`}>{error.digest ?? error.message}</p>
      <button type="button" className={`t-label ${ui.btn} ${ui.lg} ${ui.fill}`} onClick={retry}>
        Try again
      </button>
    </FirstRunPage>
  );
}
