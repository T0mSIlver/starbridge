// The Starbridge opencode plugin's source files, which setup writes into opencode's config folder
// with the repository's layout. Plain JavaScript, so the type checker does not read the imports
// as TypeScript modules; Bun bundles each file as text.
import agent from "../../../mod/hooks/agent.ts" with { type: "text" };
import node from "../../../mod/hooks/node.ts" with { type: "text" };
import poller from "../../../mod/hooks/poller.ts" with { type: "text" };
import switchLoop from "../../../mod/hooks/switch.ts" with { type: "text" };
import plugin from "../../../mod/opencode/starbridge.ts" with { type: "text" };

export default {
  "mod/opencode/starbridge.ts": plugin,
  "mod/hooks/agent.ts": agent,
  "mod/hooks/node.ts": node,
  "mod/hooks/poller.ts": poller,
  "mod/hooks/switch.ts": switchLoop,
};
