// What a permission prompt asks to run, in full (#274). `summary` is one line capped at 200
// characters, so a command's tail can hide past it; the owner allows only what they can see.
import type { Permission } from "@starbridge/protocol";

/** The longest input an inbox row shows whole, and so the longest a row may carry Allow for. */
export const ROW_INPUT_MAX = 200;

/**
 * The tool input as the owner reads it before allowing: a command's full text, then any other
 * field but its description (shown apart), as indented JSON; any other input as indented JSON.
 * Input that is not JSON shows as it came.
 */
export function fullInput(p: Pick<Permission, "input" | "summary">): string {
  if (!p.input) return p.summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(p.input);
  } catch {
    return p.input;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { command, description: _, ...rest } = parsed as Record<string, unknown>;
    if (typeof command === "string") {
      return Object.keys(rest).length === 0
        ? command
        : `${command}\n\n${JSON.stringify(rest, null, 2)}`;
    }
  }
  return JSON.stringify(parsed, null, 2);
}

/** Whether an inbox row shows the whole input on one line, so it may carry Allow. */
export function fitsRow(p: Pick<Permission, "input" | "summary">): boolean {
  const full = fullInput(p);
  return full.length <= ROW_INPUT_MAX && !full.includes("\n");
}
