/**
 * The starbridge commands an agent may run with no prompt, wherever its harness lets Starbridge
 * decide that: the Pi link (#488) and the Antigravity plugin's hook (#959). No imports, so the
 * CLI bundles it too.
 */

/** The commands allowed without asking anyone: the ones the skill tells the agent to run. */
const OWN = new Set(["ask", "waiting", "working", "wait", "settle", "hello"]);

/**
 * Whether `command` runs one starbridge command of OWN and nothing else (#488): it starts with
 * `starbridge <subcommand>`, and outside quotes has no separator, pipe, redirection, subshell,
 * expansion, escape or line break other than a backslash that joins two lines, as the skill's
 * examples do. Inside double quotes `$` and backquotes still expand, so they count too. Anything
 * it is unsure of goes to the owner, as any other command does.
 */
export function ownCommand(command: string): boolean {
  const head = /^starbridge ([a-z]+)(?=$|[ \t])/.exec(command);
  if (!head?.[1] || !OWN.has(head[1])) return false;
  let quote: "'" | '"' | undefined;
  for (let i = head[0].length; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "$" || c === "`") return false;
      else if (c === "\\") i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && command[i + 1] === "\n") i++;
    else if (!/[A-Za-z0-9 \t_\-.,:=+/@%^~*?[\]]/.test(c)) return false;
  }
  return quote === undefined;
}
