// The Starbridge opencode plugin's source files, which setup writes into opencode's config folder
// with the repository's layout. Plain JavaScript, so the type checker does not read the macro's
// import attribute; Bun inlines each file's text when it bundles or loads this one.
import { source } from "./source.ts" with { type: "macro" };

export default {
  "mod/opencode/starbridge.ts": source("mod/opencode/starbridge.ts"),
  "mod/hooks/address.ts": source("mod/hooks/address.ts"),
  "mod/hooks/agent.ts": source("mod/hooks/agent.ts"),
  "mod/hooks/node.ts": source("mod/hooks/node.ts"),
  "mod/hooks/poller.ts": source("mod/hooks/poller.ts"),
  "mod/hooks/switch.ts": source("mod/hooks/switch.ts"),
};
