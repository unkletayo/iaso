import { z } from "zod";
import type { ExecResult } from "../sandbox/types.js";
import { type Tool, defineTool } from "./schema.js";

export const bashDefinition = defineTool({
  name: "bash",
  description:
    "Run a shell command in /repo inside the sandbox. Returns the exit code, stdout and stderr. " +
    "Default timeout is 120 seconds, maximum 600. A command that times out is killed.",
  input: z.strictObject({
    cmd: z.string().min(1),
    timeoutSec: z.number().int().min(1).max(600).optional(),
  }),
});

/** The sandbox's own default, used when the model gives no timeout. */
export const BASH_DEFAULT_TIMEOUT_SEC = 120;

/**
 * Render an exec result for the model. stderr goes last so truncation keeps the end of it.
 * `byRunLimit` says the timeout was cut short to fit the run's remaining time.
 */
export function formatExecResult(
  res: ExecResult,
  timeoutSec: number | undefined,
  byRunLimit = false,
): string {
  const parts = [`exit code: ${String(res.exitCode)}`];
  if (res.timedOut) {
    const limit = timeoutSec === undefined ? "the time limit" : `${String(timeoutSec)}s`;
    const why = byRunLimit ? " (all the time left in the run)" : "";
    parts.push(`TIMED OUT after ${limit}${why}: the command was killed.`);
  }
  if (res.stdout !== "") parts.push(`--- stdout ---\n${res.stdout.replace(/\n$/, "")}`);
  if (res.stderr !== "") parts.push(`--- stderr ---\n${res.stderr.replace(/\n$/, "")}`);
  if (res.stdout === "" && res.stderr === "") parts.push("(no output)");
  return parts.join("\n");
}

export const bashTool: Tool<typeof bashDefinition.input> = {
  definition: bashDefinition,
  async run({ cmd, timeoutSec }, { sandbox, timeLeftSec }) {
    // M13 step 13C: a command never outlives the run's time limit.
    const wanted = timeoutSec ?? BASH_DEFAULT_TIMEOUT_SEC;
    const byRunLimit = timeLeftSec !== undefined && timeLeftSec < wanted;
    const limit = byRunLimit ? timeLeftSec : timeoutSec;
    const res = await sandbox.exec(cmd, limit === undefined ? {} : { timeoutSec: limit });
    // A non-zero exit is information (a failing test is the point of running it), not a tool
    // failure. Only a timeout is flagged as an error.
    return { output: formatExecResult(res, limit, byRunLimit), isError: res.timedOut };
  },
};
