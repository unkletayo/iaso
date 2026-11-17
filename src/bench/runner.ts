import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { PhaseSetup, PipelineStatus } from "../agent/pipeline.js";
import type { BudgetLimits } from "../config.js";
import { runAttempts } from "../agent/attempts.js";
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
  /** Iaso's own check of the kept patch (13A); absent in records made before it existed. */
  check: z.enum(["verified", "failed", "not_checked"]).optional(),
  /** Set when the task was given more than one attempt (13G). `costUsd` and `steps` cover them all. */
  attempts: z.object({ kept: z.number().int().min(1), made: z.number().int().min(1) }).optional(),
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
  /**
   * Stop starting instances when the money spent in this folder (earlier runs included) reaches
   * this. A running instance is held to what is left, so the total can pass it by about one model
   * call per running instance, not more.
   */
  maxTotalCostUsd?: number;
  concurrency: number;
  usePlan: boolean;
  /** Attempts per task, each in a fresh sandbox within the task's cap (13G). Default 1. */
  attempts?: number;
  /** Skip instances that already have a record. Without it, a folder with records is refused. */
  resume: boolean;
  keepImages: boolean;
}

export interface BenchDeps {
  createSandbox: (instance: SweInstance, runId: string) => Sandbox;
  fix: PhaseSetup;
  /** Fix-phase setups for the attempts after the first, used in turn (see `--attempt-models`). */
  attemptFix?: PhaseSetup[];
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
  /** Everything spent in the folder, earlier runs included. */
  costUsd: number;
  /** The total cost limit ended the bench before every instance had started. */
  stoppedForCost: boolean;
  /** Instances left without a record because of that. `--resume` can run them. */
  notStarted: number;
}

/** An instance gets less than this share of the per-instance cap only by being skipped instead. */
export const MIN_CAP_SHARE = 0.25;

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
    stoppedForCost: false,
    notStarted: 0,
  };
  if (summary.skipped > 0) deps.log(`resuming: ${String(summary.skipped)} already done`);

  // Appends are chained, so two instances finishing together cannot interleave their lines.
  let writes: Promise<void> = Promise.resolve();
  const append = (file: string, value: unknown): Promise<void> => {
    writes = writes.then(() => appendFile(join(o.benchDir, file), `${JSON.stringify(value)}\n`));
    return writes;
  };

  async function runOne(instance: SweInstance, position: number, cap: number): Promise<void> {
    const started = Date.now();
    const id = instance.instanceId;
    const runDir = join(o.benchDir, "runs", id);
    const stamp = Date.now().toString(36);
    let record: TaskRecord;
    let patch = "";
    try {
      const outcome = await runAttempts({
        attempts: o.attempts ?? 1,
        limits: { ...o.limits, maxCostUsd: cap },
        runDir,
        createSandbox: (attempt) =>
          deps.createSandbox(
            instance,
            `bench-${id}-${stamp}${attempt === 1 ? "" : `-a${String(attempt)}`}`,
          ),
        prepare: async (sandbox) => {
          // The fix is public. With no network the agent cannot look it up.
          await sandbox.setNetwork(false);
          return { network: "off", installCommand: "(none: the image is prebuilt)" };
        },
        pipeline: {
          fix: deps.fix,
          ...(deps.plan ? { plan: deps.plan } : {}),
          ...(deps.compact ? { compact: deps.compact } : {}),
          issue: renderSweIssue(instance),
          usePlan: o.usePlan,
        },
        ...(deps.attemptFix !== undefined && deps.attemptFix.length > 0
          ? {
              pipelineFor: (attempt: number) => {
                const alts = (deps.attemptFix ?? []);
                const fix = attempt === 1 ? deps.fix : (alts[(attempt - 2) % alts.length] ?? deps.fix);
                return {
                  fix,
                  ...(deps.plan ? { plan: deps.plan } : {}),
                  ...(deps.compact ? { compact: deps.compact } : {}),
                  issue: renderSweIssue(instance),
                  usePlan: o.usePlan,
                };
              },
            }
          : {}),
        log: deps.log,
      });
      const res = outcome.kept.result;
      // Whatever the kept sandbox held is the answer, even if the run ran out of budget before submit.
      patch = res.diff;
      record = {
        instanceId: id,
        status: res.status,
        steps: outcome.attempts.reduce((n, a) => n + a.result.steps, 0),
        costUsd: outcome.totalCostUsd,
        durationMs: Date.now() - started,
        runDir: join("runs", id),
        patchBytes: Buffer.byteLength(patch),
        ...(res.message === undefined ? {} : { message: res.message }),
        check: outcome.kept.verification.status,
        ...((o.attempts ?? 1) === 1
          ? {}
          : { attempts: { kept: outcome.kept.attempt, made: outcome.attempts.length } }),
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
      if (!o.keepImages) await deps.removeImage(instanceImage(id)).catch(() => undefined);
    }
  }

  // What the instances now running may still spend. Reserved when one starts, given back when it ends.
  let reserved = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const position = next;
      const instance = todo[position];
      if (instance === undefined) return;

      let cap = o.limits.maxCostUsd;
      if (o.maxTotalCostUsd !== undefined) {
        const available = o.maxTotalCostUsd - summary.costUsd - reserved;
        if (available < MIN_CAP_SHARE * o.limits.maxCostUsd) {
          if (!summary.stoppedForCost) {
            summary.stoppedForCost = true;
            deps.log(
              `stopping: the total cost limit of $${o.maxTotalCostUsd.toFixed(2)} leaves ` +
                `$${Math.max(0, available).toFixed(2)} for the next task`,
            );
          }
          return;
        }
        cap = Math.min(cap, available);
      }
      next += 1;
      reserved += cap;
      try {
        await runOne(instance, position, cap);
      } finally {
        reserved -= cap;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, worker));
  await writes;
  summary.notStarted = todo.length - next;
  return summary;
}
