/**
 * The line that marks a file setup writes into another tool (#474): its writer and version, in
 * that file's comment syntax. A file that has it is Starbridge's: setup replaces it when it
 * differs from this release's, and uninstall removes it. Files from before 1.0.0 said "Written
 * by starbridge setup" or "Written by `starbridge setup`", which the same test recognises.
 */
import { VERSION } from "../version";

export function marker(open: string, close?: string): string {
  const text = `Written by starbridge ${VERSION}; \`starbridge uninstall\` removes it.`;
  return close ? `${open} ${text} ${close}` : `${open} ${text}`;
}

/** Whether `text` carries a marker in its first lines (after a skill's `---` or an XML header). */
export function ours(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text.split("\n", 3).some((line) => /^(#|\/\/|<!--) Written by `?starbridge\b/.test(line));
}

/** A skill with the marker as a YAML comment, first in its front matter. */
export function markedSkill(skill: string): string {
  return skill.replace(/^---\n/, `---\n${marker("#")}\n`);
}
