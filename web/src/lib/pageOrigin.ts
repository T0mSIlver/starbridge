import { useSyncExternalStore } from "react";
import { HOSTED } from "./installCommands";

const unchanging = () => () => {};

/** The hosted origin until the page runs in a browser, which knows its own. */
export function usePageOrigin(): string {
  return useSyncExternalStore(
    unchanging,
    () => location.origin,
    () => HOSTED,
  );
}
