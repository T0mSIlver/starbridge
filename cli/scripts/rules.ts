/**
 * Writes each harness's session-start rule from plugin/rules/template.md (src/setup/rules.ts).
 *
 *   bun cli/scripts/rules.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@starbridge/protocol";
import { RULE_FILES, renderRule } from "../src/setup/rules";

const ROOT = join(import.meta.dir, "..", "..");
const template = readFileSync(join(ROOT, "plugin/rules/template.md"), "utf8");
for (const [agent, file] of Object.entries(RULE_FILES))
  writeFileSync(join(ROOT, file), renderRule(template, agent as Agent));
