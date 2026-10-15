import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { truncateOutput } from "../tools/truncate.js";

/** Tool results are trimmed in the log; the raw output is not kept. */
export const LOGGED_RESULT_CHARS = 2000;

/** Spec §12: one line per loop step. */
export const TrajectoryStepSchema = z.strictObject({
  step: z.number().int().min(1),
  phase: z.enum(["plan", "reproduce", "fix", "verify", "report"]),
  model: z.string(),
  promptVersion: z.string(),
  /** Tokens the provider reported for this request. */
  tokens: z.strictObject({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cachedInput: z.number().int().nonnegative(),
  }),
  /** Estimated size of the context sent, so context growth can be plotted (spec §7A). */
  contextTokens: z.number().int().nonnegative(),
  response: z.strictObject({ text: z.string(), stopReason: z.string() }),
  toolCalls: z.array(z.strictObject({ id: z.string(), name: z.string(), input: z.unknown() })),
  toolResults: z.array(
    z.strictObject({ id: z.string(), name: z.string(), output: z.string(), isError: z.boolean() }),
  ),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export type TrajectoryStep = z.infer<typeof TrajectoryStepSchema>;

export const trajectoryPath = (runsDir: string, runId: string): string =>
  join(runsDir, runId, "trajectory.jsonl");

/** Cut a tool result for the log. */
export function trimResult(output: string): string {
  return truncateOutput(output, {
    maxChars: LOGGED_RESULT_CHARS,
    headChars: LOGGED_RESULT_CHARS / 2,
    tailChars: LOGGED_RESULT_CHARS / 2,
  });
}

/**
 * Appends one JSON line per step. Each append is its own write, so a crashed run keeps every step
 * logged before the crash.
 */
export class TrajectoryWriter {
  private ready = false;

  constructor(readonly path: string) {}

  async append(step: TrajectoryStep): Promise<void> {
    const line = JSON.stringify(
      TrajectoryStepSchema.parse({
        ...step,
        toolResults: step.toolResults.map((r) => ({ ...r, output: trimResult(r.output) })),
      }),
    );
    if (!this.ready) {
      await mkdir(dirname(this.path), { recursive: true });
      this.ready = true;
    }
    await appendFile(this.path, `${line}\n`, "utf8");
  }
}

/** Read a trajectory back (for `iaso replay`). Names the line number of any corrupt line. */
export async function readTrajectory(path: string): Promise<TrajectoryStep[]> {
  const text = await readFile(path, "utf8");
  const steps: TrajectoryStep[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      steps.push(TrajectoryStepSchema.parse(JSON.parse(line)));
    } catch (err) {
      throw new Error(
        `${path}: line ${String(i + 1)} is not a valid trajectory step (${err instanceof Error ? err.message : "unknown"})`,
        { cause: err },
      );
    }
  }
  return steps;
}
