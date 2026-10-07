---
description: Set this machine up for Starbridge, or check and repair it
argument-hint: "[--server <url>] [--providers <a,b>] [--no-quota] [--no-service] [--no-agents]"
allowed-tools: Bash(starbridge status), Bash(starbridge setup:*), Bash(command -v starbridge)
---

Set this machine up for Starbridge with the `starbridge` CLI. Your Bash tool has no terminal,
so setup cannot ask its own questions: ask them yourself, then run it with `--yes` and flags.

1. Run `command -v starbridge`. If it prints nothing, tell me to install the CLI with
   `curl -fsSL https://starbridge.run/install.sh | sh` (on Windows, `irm https://starbridge.run/install.ps1 | iex`
   in PowerShell; or `brew install T0mSIlver/starbridge/starbridge`, or `npm i -g starbridge`) and stop.
2. Run `starbridge status` and tell me in a few lines what is already set up and what is missing.
3. Before you run setup, tell me what `--yes` will change outside Starbridge and ask me to confirm:
   installing CodexBar if it is missing, which only quotas need (`--no-quota` skips it); installing Starbridge in every agent it finds (Claude
   Code, Codex, Pi, opencode; `--no-agents` skips them); stopping and removing an old
   `starbridge quota push` unit; replacing a copied mod, skill or CLAUDE.md rule; turning on
   plugin auto-update; adding the CLI's folder to the PATH in your shell profile; on Linux,
   keeping the agent running after logout (`loginctl enable-linger`). If the machine is not
   paired, ask which server to use (default `https://starbridge.run`).
4. Run `starbridge setup --yes` with the flags I gave ($ARGUMENTS) and the answers from step 3,
   in the background. When it is not paired yet, it prints a pairing link and a code: give me
   both at once. I open the link on my phone, or type the code under Devices in the Starbridge
   app or web page, within 10 minutes.
5. When setup finishes, give me its result in a few lines: the providers it uploads, whether the
   agent runs, and anything that failed with the command that fixes it. Sessions load the plugins
   when they next start.
