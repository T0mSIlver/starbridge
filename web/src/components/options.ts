import type { Decision } from "@/lib/types";

/** Recommended first (SPEC.md, "Decisions as notifications"). */
export function ordered(d: Decision): string[] {
  return d.recommended
    ? [d.recommended, ...d.options.filter((o) => o !== d.recommended)]
    : d.options;
}
