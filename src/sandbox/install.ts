import { z } from "zod";
import type { Sandbox } from "./types.js";

/**
 * M13 step 13D: run the project's install command with the network on, then cut the network for
 * the rest of the run, so code in the repo (or an instruction planted in the issue) cannot send
 * anything out. Without an install command the agent may still need to install things itself, so
 * the network stays on and the report says so.
 */

/** Installs can be slow; this is the whole budget for one install command. */
export const INSTALL_TIMEOUT_SEC = 900;
const TAIL_LINES = 20;

/** Told to the model when the network is off, so it does not spend steps trying to download. */
export const OFFLINE_RULE =
  "The sandbox has no network. The project's dependencies are already installed; do not try to download or install packages.";

export const networkStateSchema = z.discriminatedUnion("network", [
  z.object({ network: z.literal("off"), installCommand: z.string() }),
  z.object({ network: z.literal("on"), reason: z.string() }),
]);
export type NetworkState = z.infer<typeof networkStateSchema>;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** Throws `InstallError` when the install fails, before any model call is paid for. */
export async function installThenCutNetwork(
  sandbox: Sandbox,
  installCommand: string | undefined,
  log: (line: string) => void,
): Promise<NetworkState> {
  if (installCommand === undefined) {
    return { network: "on", reason: "no installCommand in .iaso.json" };
  }
  log(`installing: ${installCommand}`);
  const res = await sandbox.exec(installCommand, { timeoutSec: INSTALL_TIMEOUT_SEC });
  if (res.exitCode !== 0 || res.timedOut) {
    const how = res.timedOut
      ? `timed out after ${String(INSTALL_TIMEOUT_SEC)}s`
      : `exit ${String(res.exitCode)}`;
    const tail = `${res.stdout}\n${res.stderr}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
    throw new InstallError(`The install command failed (${how}): ${installCommand}\n${tail}`);
  }
  await sandbox.setNetwork(false);
  log("network: off for the rest of the run");
  return { network: "off", installCommand };
}

/** One line for `report.md`. */
export function describeNetwork(state: NetworkState): string {
  return state.network === "off"
    ? `off after \`${state.installCommand}\``
    : `on for the whole run (${state.reason})`;
}
