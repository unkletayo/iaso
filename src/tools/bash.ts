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

/** Render an exec result for the model. stderr goes last so truncation keeps the end of it. */
export function formatExecResult(res: ExecResult, timeoutSec: number | undefined): string {
  const parts = [`exit code: ${String(res.exitCode)}`];
  if (res.timedOut) {
    const limit = timeoutSec === undefined ? "the time limit" : `${String(timeoutSec)}s`;
    parts.push(`TIMED OUT after ${limit}: the command was killed.`);
  }
  if (res.stdout !== "") parts.push(`--- stdout ---\n${res.stdout.replace(/\n$/, "")}`);
  if (res.stderr !== "") parts.push(`--- stderr ---\n${res.stderr.replace(/\n$/, "")}`);
  if (res.stdout === "" && res.stderr === "") parts.push("(no output)");
  return parts.join("\n");
}

export const bashTool: Tool<typeof bashDefinition.input> = {
  definition: bashDefinition,
  async run({ cmd, timeoutSec }, { sandbox }) {
    const res = await sandbox.exec(cmd, timeoutSec === undefined ? {} : { timeoutSec });
    // A non-zero exit is information (a failing test is the point of running it), not a tool
    // failure. Only a timeout is flagged as an error.
    return { output: formatExecResult(res, timeoutSec), isError: res.timedOut };
  },
};
