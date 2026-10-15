/**
 * The starbridge commands an agent may run with no prompt, wherever its harness lets Starbridge
 * decide that: the Pi link (#488) and the Antigravity plugin's hook (#959). No imports, so the
 * CLI bundles it too.
 */

/** The commands allowed without asking anyone: the ones the skill tells the agent to run. */
const OWN = new Set(["ask", "waiting", "working", "wait", "settle", "hello"]);

/** Quote marks PowerShell reads as `'` or `"`, which a POSIX shell takes as plain text. */
const TYPOGRAPHIC_QUOTES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e]/;

/**
 * Whether `command` runs one starbridge command of OWN and nothing else (#488): it starts with
 * `starbridge <subcommand>`, and outside quotes has no separator, pipe, redirection, subshell,
 * expansion, escape or line break other than a backslash that joins two lines, as the skill's
 * examples do. Inside double quotes `$` and backquotes still expand, so they count too. Anything
 * it is unsure of goes to the owner, as any other command does.
 *
 * On Windows the line may run in PowerShell, where a backslash escapes nothing and joins no lines
 * and typographic quotes open and close strings, so a line that reads as one command to a POSIX
 * shell can be several there: `windows` refuses a backslash outside single quotes and any
 * typographic quote (#1749).
 */
export function ownCommand(
  command: string,
  windows = typeof process !== "undefined" && process.platform === "win32",
): boolean {
  const head = /^starbridge ([a-z]+)(?=$|[ \t])/.exec(command);
  if (!head?.[1] || !OWN.has(head[1])) return false;
  if (windows && TYPOGRAPHIC_QUOTES.test(command)) return false;
  // `settle` closes one decision of the agent's own: `--all` and `--session` close many (#1761).
  if (head[1] === "settle" && !/^starbridge settle d_[A-Za-z0-9_-]+(?=$|[ \t])/.test(command))
    return false;
  let quote: "'" | '"' | undefined;
  for (let i = head[0].length; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
    } else if (windows && c === "\\") return false;
    else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "$" || c === "`") return false;
      else if (c === "\\") i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\" && command[i + 1] === "\n") i++;
    else if (!/[A-Za-z0-9 \t_\-.,:=+/@%^~*?[\]]/.test(c)) return false;
  }
  return quote === undefined;
}
