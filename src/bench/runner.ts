import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type PhaseSetup, type PipelineStatus, runPipeline } from "../agent/pipeline.js";
import type { BudgetLimits } from "../config.js";
import { instanceImage } from "../sandbox/prebuilt.js";
import type { Sandbox } from "../sandbox/types.js";
import { type SweInstance, renderSweIssue } from "../sources/swebench.js";

/** One line of `predictions.jsonl`, in the format the official SWE-bench harness reads. */
export const predictionSchema = z.object({
  instance_id: z.string(),
  model_name_or_path: z.string(),
  model_patch: z.string(),
});
export type Prediction = z.infer<typeof predictionSchema>;

export type TaskStatus = PipelineStatus | "error";

/** One line of `tasks.jsonl`: what the agent did, before the harness says whether it worked. */
export const taskRecordSchema = z.object({
  instanceId: z.string(),
  status: z.string(),
  steps: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  /** Relative to the bench folder. */
  runDir: z.string(),
  patchBytes: z.number(),
  message: z.string().optional(),
});
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export class BenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchError";
  }
}

const PREDICTIONS = "predictions.jsonl";
const TASKS = "tasks.jsonl";

/** Parse a JSONL file. A missing file is empty; a half-written last line (a crash) is skipped. */
async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A line cut off by a crash. The instance has no complete record, so it runs again.
    }
  }
  return out;
}

export const readTasks = (benchDir: string): Promise<TaskRecord[]> =>
  readJsonl(join(benchDir, TASKS), taskRecordSchema);

/** Last prediction per instance, so a rerun after a crash cannot count twice. */
export async function readPredictions(benchDir: string): Promise<Prediction[]> {
  const all = await readJsonl(join(benchDir, PREDICTIONS), predictionSchema);
  return [...new Map(all.map((p) => [p.instance_id, p])).values()];
}

export interface BenchOptions {
  instances: readonly SweInstance[];
  /** Goes into every prediction as `model_name_or_path`. */
  modelName: string;
  benchDir: string;
  /** Limits for each instance, not for the whole bench. */
  limits: BudgetLimits;
  concurrency: number;
  usePlan: boolean;
  /** Skip instances that already have a record. Without it, a folder with records is refused. */
  resume: boolean;
  keepImages: boolean;
}

export interface BenchDeps {
  createSandbox: (instance: SweInstance, runId: string) => Sandbox;
  fix: PhaseSetup;
  plan?: PhaseSetup;
  compact?: PhaseSetup;
  /** Remove an instance image to save disk. Failures are ignored. */
  removeImage: (image: string) => Promise<void>;
  log: (line: string) => void;
}

export interface BenchSummary {
  total: number;
  ran: number;
  skipped: number;
  submitted: number;
  costUsd: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run each instance through the plan-and-fix pipeline in its own sandbox, and append a prediction
 * and a task record the moment it finishes. A crash, a bad image or a model error ends only that
 * instance: it gets an empty patch and a record saying why, and the bench goes on.
 */
export async function runBench(o: BenchOptions, deps: BenchDeps): Promise<BenchSummary> {
  await mkdir(join(o.benchDir, "runs"), { recursive: true });
  const existing = await readTasks(o.benchDir);
  if (existing.length > 0 && !o.resume) {
    throw new BenchError(
      `${o.benchDir} already has ${String(existing.length)} finished tasks. ` +
        "Use --resume to continue it, or --out to use another folder.",
    );
  }
  const done = new Set(existing.map((t) => t.instanceId));
  const todo = o.instances.filter((i) => !done.has(i.instanceId));
  const summary: BenchSummary = {
    total: o.instances.length,
    ran: 0,
    skipped: o.instances.length - todo.length,
    submitted: existing.filter((t) => t.status === "submitted").length,
    costUsd: existing.reduce((sum, t) => sum + t.costUsd, 0),
  };
  if (summary.skipped > 0) deps.log(`resuming: ${String(summary.skipped)} already done`);

  // Appends are chained, so two instances finishing together cannot interleave their lines.
  let writes: Promise<void> = Promise.resolve();
  const append = (file: string, value: unknown): Promise<void> => {
    writes = writes.then(() => appendFile(join(o.benchDir, file), `${JSON.stringify(value)}\n`));
    return writes;
  };

  async function runOne(instance: SweInstance, position: number): Promise<void> {
    const started = Date.now();
    const id = instance.instanceId;
    const runDir = join(o.benchDir, "runs", id);
    const sandbox = deps.createSandbox(instance, `bench-${id}-${Date.now().toString(36)}`);
    let record: TaskRecord;
    let patch = "";
    try {
      await sandbox.start();
      // The fix is public. With no network the agent cannot look it up.
      await sandbox.setNetwork(false);
      const res = await runPipeline({
        fix: deps.fix,
        ...(deps.plan ? { plan: deps.plan } : {}),
        ...(deps.compact ? { compact: deps.compact } : {}),
        sandbox,
        issue: renderSweIssue(instance),
        limits: o.limits,
        runDir,
        usePlan: o.usePlan,
      });
      // Whatever the sandbox holds is the answer, even if the run ran out of budget before submit.
      patch = res.diff;
      record = {
        instanceId: id,
        status: res.status,
        steps: res.steps,
        costUsd: res.costUsd,
        durationMs: Date.now() - started,
        runDir: join("runs", id),
        patchBytes: Buffer.byteLength(patch),
        ...(res.message === undefined ? {} : { message: res.message }),
      };
    } catch (err) {
      record = {
        instanceId: id,
        status: "error",
        steps: 0,
        costUsd: 0,
        durationMs: Date.now() - started,
        runDir: join("runs", id),
        patchBytes: 0,
        message: message(err),
      };
    }
    try {
      // The result is saved before cleanup, so a slow or failed cleanup cannot lose it.
      await append(PREDICTIONS, {
        instance_id: id,
        model_name_or_path: o.modelName,
        model_patch: patch,
      } satisfies Prediction);
      await append(TASKS, record);
      summary.ran += 1;
      summary.costUsd += record.costUsd;
      if (record.status === "submitted") summary.submitted += 1;
      deps.log(
        `[${String(summary.skipped + position + 1)}/${String(summary.total)}] ${id}: ${record.status}, ` +
          `${String(record.steps)} steps, $${record.costUsd.toFixed(2)}` +
          (record.message && record.status === "error" ? ` (${record.message})` : ""),
      );
    } finally {
      await sandbox.destroy().catch(() => undefined);
      if (!o.keepImages) await deps.removeImage(instanceImage(id)).catch(() => undefined);
    }
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const position = next++;
      const instance = todo[position];
      if (instance === undefined) return;
      await runOne(instance, position);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, worker));
  await writes;
  return summary;
}
