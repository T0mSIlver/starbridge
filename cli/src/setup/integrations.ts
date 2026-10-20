/**
 * Everything setup puts on a machine besides its config folder: Starbridge in each agent
 * (`HARNESSES`), the agent's user service with lingering, and the PATH line. Status and uninstall
 * read these entries, and cli/test/integrations.test.ts checks that setup writes nothing outside
 * their `paths`, so a new integration cannot be one that uninstall and status do not know.
 */
import { AGENT_IDS, AGENTS, HARNESSES } from "./agents";
import { removePathLines, startupFiles } from "./path";
import { lingering, removeService, serviceFiles, serviceState, undoLinger } from "./service";
import type { Sys } from "./sys";

/** The agent's user service, and lingering, which setup turns on for it on Linux. */
export const SERVICE = {
  paths: serviceFiles,
  async status(sys: Sys): Promise<string[]> {
    const svc = await serviceState(sys);
    const lines = [
      svc.installed
        ? `Service: ${svc.state}${svc.enabled === undefined ? "" : svc.enabled ? ", enabled" : ", not enabled"}`
        : "Service: not installed",
    ];
    if ((await lingering(sys)) === false)
      lines.push("  Lingering is off: the agent stops when your last login session ends.");
    return lines;
  },
  /**
   * Stops and removes the service, then turns lingering off when setup turned it on. `stopped` is
   * false when the service could not be stopped: it stays, and so does what it uses.
   */
  async remove(sys: Sys): Promise<{ lines: string[]; stopped: boolean }> {
    let removed: boolean;
    try {
      removed = await removeService(sys);
    } catch (e) {
      return {
        lines: [`Could not stop the agent service, so it stays: ${(e as Error).message}`],
        stopped: false,
      };
    }
    const lines = [
      removed ? "Stopped and removed the agent service." : "No agent service installed.",
    ];
    const linger = await undoLinger(sys);
    if (linger) lines.push(linger);
    return { lines, stopped: true };
  },
};

/** The line setup adds to the shell's startup file when the binary's folder is not on the PATH. */
export const PATH_LINE = {
  paths: startupFiles,
  /** Takes out the line for `dir`, the installed binary's folder. */
  remove: (sys: Sys, dir: string) =>
    removePathLines(sys, dir).map((file) => `Removed the PATH line setup added to ${file}.`),
};

export interface Integration {
  name: string;
  /** Every file and folder setup may write for it. */
  paths(sys: Sys): string[];
}

/** Every integration, by what it writes. */
export const INTEGRATIONS: Integration[] = [
  ...AGENT_IDS.map((id) => ({ name: AGENTS[id], paths: (sys: Sys) => HARNESSES[id].paths(sys) })),
  { name: "the agent's service", paths: SERVICE.paths },
  { name: "the PATH line", paths: PATH_LINE.paths },
];
