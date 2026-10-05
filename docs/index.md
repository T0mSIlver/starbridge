# Starbridge docs

Starbridge is where you supervise your coding agents from your phone or a browser. When an agent
needs a decision from you, you answer with one tap and the answer goes back into the session
that asked. You also follow the runs that affect you, such as a release or heavy work on your
machine, and see what each AI plan has left.

Your phone, browsers and machines encrypt everything they send each other, so the server stores
only ciphertext. Use the free server at starbridge.run, or [host your own](../server/README.md).

## Start

1. **Sign in** with GitHub on the web at [starbridge.run](https://starbridge.run) or in the
   Android app. The first device you sign in on creates your account's keys, and you approve each later
   device from one you already have.

2. **Install the CLI** on each machine that runs agents:

   ```bash
   curl -fsSL https://starbridge.run/install.sh | sh
   ```

   The script then runs `starbridge setup`, which pairs the machine: type the code it prints
   under Devices on your phone or in the web app. Setup also installs the Claude Code plugin and
   the service that uploads your quotas. Homebrew and npm work too; see
   [The CLI](../cli/README.md#install).

3. **Tell your agents** when to reach you. With the plugin, Claude Code asks you for decisions
   that are yours and reports the commands that block you. Codex needs the Starbridge skill
   copied in. [Tell your agents](tell-your-agents.md) covers both, and how to add your own rules.

## What you get

- **Questions.** An agent asks with two to four options, and code, images or links when they
  help you decide. Your tap reaches its session as the next prompt.
- **Runs.** A build, a release, an eval or heavy work on your machine shows its progress on your
  devices until it passes or fails.
- **Quotas.** Each plan's limits, such as a 5-hour and a weekly window, read from
  [CodexBar](https://github.com/steipete/CodexBar). A notification comes before a window resets
  with headroom unused, or when it runs low.
- **Permission prompts.** Allow or deny, from your phone, the commands Claude Code asks
  permission to run. Off until you turn them on.

Starbridge works with Claude Code and Codex; Pi support is coming.
[Tell your agents](tell-your-agents.md#what-each-agent-supports) lists what each one supports.
