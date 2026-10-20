/**
 * Where the machine's Starbridge agent listens and which config folder it serves: the one
 * definition the CLI (cli/src/agent/api.ts) and the mods (agent.ts) both import, so they never
 * work out two addresses for one machine (#1968). Pure: the mod's host has no Node modules, so
 * the caller passes its SHA-256 and its path join.
 */

/**
 * The header a client sends with its config folder's `configKey` when it worked out the agent's
 * address from that folder. The agent answers 421 `other-config` when the key is not its own
 * (#1966), so a client never acts as another configuration's machine; a client that sends none,
 * as one named by `$STARBRIDGE_AGENT_SOCKET` or one older than this header, is served.
 */
export const CONFIG_HEADER = "starbridge-config";

/**
 * A short key for config folder `dir`: the first 16 hex digits of the SHA-256 (`sha256`, in hex)
 * of its path, with runs of `/` as one, no trailing `/`, and on Windows `\` as `/`, so the mod,
 * which builds the path from `$HOME` by hand, and the CLI, which uses `path.join`, get the same
 * key. Elsewhere `\` is a character of a name, and two folders must not share a key. The CLI
 * hashes synchronously; the mod's host has only WebCrypto, which answers with a promise.
 */
export function configKey(dir: string, windows: boolean, sha256: (text: string) => string): string;
export function configKey(
  dir: string,
  windows: boolean,
  sha256: (text: string) => Promise<string>,
): Promise<string>;
export function configKey(
  dir: string,
  windows: boolean,
  sha256: (text: string) => string | Promise<string>,
): string | Promise<string> {
  const path = (windows ? dir.replace(/\\/g, "/") : dir)
    .replace(/\/+/g, "/")
    .replace(/(.)\/$/, "$1");
  const hex = sha256(path);
  return typeof hex === "string" ? hex.slice(0, 16) : hex.then((h) => h.slice(0, 16));
}

/**
 * Where the agent of config folder `dir` listens. `$STARBRIDGE_AGENT_SOCKET` wins. On Windows,
 * the port file `agent.port` in the config folder (the CLI's `PortFile`). Elsewhere, for the
 * default config folder `standard`, `$XDG_RUNTIME_DIR/starbridge/agent-<key>.sock` when that is
 * set (Linux), else `agent.sock` in the config folder: macOS caps socket paths at 104 bytes, and
 * its config path stays short. `key`, the folder's `configKey`, keeps two homes of one user,
 * which share `$XDG_RUNTIME_DIR`, on their own agents (#1966). Any other config folder
 * (`$STARBRIDGE_CONFIG_DIR`, tests) keeps its socket inside it.
 */
export function agentSocket(
  env: { STARBRIDGE_AGENT_SOCKET?: string; XDG_RUNTIME_DIR?: string },
  dir: { path: string; standard: string; key: string },
  windows: boolean,
  join: (...parts: string[]) => string,
): string {
  if (env.STARBRIDGE_AGENT_SOCKET) return env.STARBRIDGE_AGENT_SOCKET;
  if (windows) return join(dir.path, "agent.port");
  if (env.XDG_RUNTIME_DIR && dir.path === dir.standard)
    return join(env.XDG_RUNTIME_DIR, "starbridge", `agent-${dir.key}.sock`);
  return join(dir.path, "agent.sock");
}

/**
 * Where an agent on loopback TCP listens, in the file its address names (#552). Node and Bun take
 * a socket path on Windows as a named pipe, which other local users can open, so there the agent
 * listens on 127.0.0.1 and writes this file into the config directory, which only its user can
 * read. `token`, new at each start, never crosses the wire: a call carries a fresh nonce and
 * `proof(token, "client", nonce)`, and the agent answers with `proof(token, "agent", nonce)`, so
 * a process that took the port after the agent stopped learns nothing it can use and cannot
 * answer. An address ending in `.port` names such a file on any platform.
 */
export interface PortFile {
  port: number;
  token: string;
  pid: number;
}

export const isPortFile = (address: string) => address.endsWith(".port");

/** The port file in `text`, or undefined when it is not one. */
export function portTarget(text: string): PortFile | undefined {
  try {
    const f = JSON.parse(text) as { port?: unknown; token?: unknown; pid?: unknown };
    if (
      Number.isInteger(f.port) &&
      typeof f.token === "string" &&
      f.token.length >= 32 &&
      Number.isInteger(f.pid)
    )
      return { port: f.port as number, token: f.token, pid: f.pid as number };
  } catch {}
  return undefined;
}
