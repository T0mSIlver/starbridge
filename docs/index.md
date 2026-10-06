# Starbridge docs

Starbridge is where you supervise your coding agents from your phone or a browser. When an agent
needs a decision from you, you answer with one tap and the answer goes back into the session
that asked. You also follow the runs that affect you, such as a release or heavy work on your
machine.

Your phone, browsers and machines encrypt everything they send each other, so the server stores
only ciphertext. Use the free server at starbridge.run, or [host your own](../server/README.md).

## Start

1. **Sign in** with GitHub on the web at [starbridge.run](https://starbridge.run) or in the
   Android app. The first device you sign in on creates your account's keys and shows your
   [recovery key](#recovery-key) once. You approve each later device from one you already have.

2. **Install the CLI** on each machine that runs agents:

   ```bash
   curl -fsSL https://starbridge.run/install.sh | sh
   ```

   The script then runs `starbridge setup`, which pairs the machine. Open the link it prints in a
   browser where you are signed in, or type the code it prints in Settings → Devices → Add a
   device, on your phone or in the web app. Setup also installs Starbridge in each agent it finds
   and the service that uploads your quotas. Homebrew and npm work too; see
   [The CLI](../cli/README.md#install).

3. **Tell your agents** when to reach you. With the plugin, Claude Code asks you for decisions
   that are yours and reports the commands that block you. Pi and opencode get the same rules from
   their Starbridge package and plugin. Codex gets the skill only, so add your own rules there.
   [Tell your agents](tell-your-agents.md) covers each agent, and how to add your own rules.

## What you get

- **Questions.** An agent asks with two to four options, and code, images or links when they
  help you decide. Your tap reaches its session as the next prompt.
- **Runs.** A build, a release, an eval or heavy work on your machine shows its progress on your
  devices until it passes or fails.
- **Quotas.** What's left on each AI plan, read from
  [CodexBar](https://github.com/steipete/CodexBar), with an optional alert before a window runs
  out.
- **Permission prompts.** Allow or deny, from your phone, the calls Claude Code, opencode and Pi
  ask permission for. Off until you turn them on.

Starbridge works with Claude Code, Codex, Pi and opencode.
[Tell your agents](tell-your-agents.md#what-each-agent-supports) lists what each one supports.

## Recovery key

The recovery key adds a new device to your account when you have lost every device. The first
device you sign in on shows it once. Store it somewhere safe, away from your devices, such as a
password manager or paper. A lost key can't be replaced, but you keep using the devices you have.

To replace the key, pick Replace next to Recovery key: on the web under Settings → Devices, in the
app under Settings → Devices and machines. Replacing asks for the current key, and the old key
stops working.

To recover, sign in on a new phone or browser and pick "Use the recovery key". Recovering removes
every other device and machine from the account. Add your phones and browsers again from
Settings → Devices → Add a device, and pair each machine again:

```bash
starbridge pair --force
```
