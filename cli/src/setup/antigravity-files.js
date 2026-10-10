// The Starbridge Antigravity plugin's own files, which setup writes into its folder. Plain
// JavaScript, so the type checker does not read the JSON imports as JSON modules; Bun bundles
// each file as text.
import hooks from "../../../mod/antigravity/hooks.json" with { type: "text" };
import manifest from "../../../mod/antigravity/plugin.json" with { type: "text" };
import preTool from "../../../mod/antigravity/pre-tool.sh" with { type: "text" };
import cli from "../../../plugin/hooks/cli.sh" with { type: "text" };

export default {
  "plugin.json": manifest,
  "hooks.json": hooks,
  "pre-tool.sh": preTool,
  "cli.sh": cli,
};
