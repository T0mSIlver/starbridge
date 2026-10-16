# Permission prompts

When a coding agent asks permission to run a tool (Claude Code's
PermissionRequest hook), Starbridge shows the prompt with Allow and Deny; the
owner's tap goes back to the hook, which tells the agent. Off until the
machine turns it on.

## Sub-features

- `allow`, `deny`: the two buttons.
- `race`: the agent's own terminal answers first; the prompt closes.

## How to get to it (user POV)

- The inbox: a card with the tool (Bash) and its command.

## Driving it with drive.ts

Preconditions: `machine("perm-on", ["config", "permissions", "on"])`, exit 0.

- Agent asks: `prompt({ session_id, cwd, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } })`.
- Owner sees it: `getByText(command).first()`.
- Owner allows: `getByRole("button", { name: "Allow" }).first().click()`.
- Agent gets it: the promise resolves to
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`.

## Gotchas

- Without `config permissions on` the hook passes the prompt to the agent's
  own terminal and nothing shows on the web.
- CI's e2e shows a prompt (inbox part, worst-case content) but does not
  answer it; answering is covered only by this scenario.
