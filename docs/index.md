# Starbridge docs

Starbridge brings the questions your coding agents ask to your phone and browser. You answer
with one tap, and the answer goes back into the session that asked. The same screens show the
runs that need you at the machine and how much of each AI plan's quota you have left.

Starbridge works best with Claude Code; Codex is supported. Claude Code loads the Starbridge
plugin, which tells each session when to ask you and brings your answer back as its next prompt.
Codex and other agents don't load the plugin, so they ask and wait through the `starbridge` CLI,
as [Tell your agents](tell-your-agents.md) describes.

## Start

1. Sign in at [starbridge.run](https://starbridge.run) with GitHub, on the web or in the Android
   app. That device creates your account's keys.
2. [Install the CLI](../cli/README.md) on each machine your agents run on, and pair it.
3. [Tell your agents](tell-your-agents.md) when to reach you.

To keep everything on your own server, see [Self-host](../server/README.md).
