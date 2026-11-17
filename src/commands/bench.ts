import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Command, InvalidArgumentError } from "commander";
import Docker from "dockerode";
import { z } from "zod";
import type { PhaseSetup } from "../agent/pipeline.js";
import {
  type HarnessOptions,
  type HarnessReport,
  HarnessError,
  runHarness,
} from "../bench/harness.js";
import { renderResults } from "../bench/results.js";
import { type BenchSummary, readTasks, runBench } from "../bench/runner.js";
import { BUDGET_DEFAULTS, type BudgetLimits } from "../config.js";
import { findModel, loadCatalogue } from "../models.js";
import { EFFORT_LEVELS, type Effort, type ModelProvider } from "../providers/types.js";
import { createProvider } from "../providers/registry.js";
import { DockerSandbox } from "../sandbox/docker.js";
import { SANDBOX_LIMITS } from "../sandbox/images.js";
import { SWEBENCH_REPO, instanceImage } from "../sandbox/prebuilt.js";
import type { Sandbox } from "../sandbox/types.js";
import { type SweInstance, loadSweLite, sampleInstances } from "../sources/swebench.js";
import { DEFAULT_MODEL, defaultCompactModel, parseEffort } from "./run.js";

/** The one dataset so far. The option exists so others (SWE-bench Multilingual) can join. */
export const DATASETS = ["swebench-lite"] as const;

export interface BenchCommandOptions {
  dataset: string;
  /** Required: a bench costs money, so it never starts with a guessed size. */
  sample?: number;
  seed: number;
  concurrency: number;
  model: string;
  planModel?: string;
  /** Reasoning effort for the plan and fix phases. */
  effort?: Effort;
  /** Attempts per task (13G). Default 1. */
  attempts?: number;
  compactModel?: string;
  /** False with `--no-plan`. */
  plan: boolean;
  maxSteps: number;
  maxCost: number;
  maxTime: number;
  /** Stop starting tasks once this much has been spent in the bench folder. */
  maxTotalCost?: number;
  out?: string;
  resume?: boolean;
  keepImages?: boolean;
  refresh?: boolean;
  /** False with `--no-evaluate`: write predictions and results, but do not run the harness. */
  evaluate?: boolean;
}

/** Everything the command touches outside itself, so tests can swap it. */
export interface BenchCommandDeps {
  loadInstances: (refresh: boolean) => Promise<SweInstance[]>;
  createProvider: (id: string) => ModelProvider;
  createSandbox: (instance: SweInstance, runId: string) => Sandbox;
  removeImage: (image: string) => Promise<void>;
  /** Memory the Docker VM has, if it can be read. */
  dockerMemoryBytes: () => Promise<number | undefined>;
  /** Grade the predictions with the official harness. */
  evaluate: (o: HarnessOptions) => Promise<HarnessReport>;
  /** `process.arch` of the machine running Docker's client. */
  hostArch: () => string;
  log: (line: string) => void;
}

export function defaultBenchDeps(): BenchCommandDeps {
  return {
    loadInstances: (refresh) => loadSweLite({ refresh }),
    createProvider: (id) => createProvider(id),
    createSandbox: (instance, runId) =>
      new DockerSandbox({
        runId,
        image: instanceImage(instance.instanceId),
        prebuilt: SWEBENCH_REPO,
      }),
    removeImage: async (image) => {
      await new Docker().getImage(image).remove();
    },
    dockerMemoryBytes: async () => {
      try {
        const info: unknown = await new Docker().info();
        const parsed = z.object({ MemTotal: z.number().positive() }).safeParse(info);
        return parsed.success ? parsed.data.MemTotal : undefined;
      } catch {
        return undefined;
      }
    },
    evaluate: (o) => runHarness(o),
    hostArch: () => process.arch,
    log: (line) => {
      console.log(line);
    },
  };
}

/** `runs/bench-swebench-lite-<model>-seed42-n10`: the same command finds the same folder to resume. */
export function defaultBenchDir(
  o: Pick<BenchCommandOptions, "dataset" | "model" | "seed" | "sample">,
): string {
  const model = o.model.replace(/[^A-Za-z0-9.-]+/g, "-");
  return join(
    "runs",
    `bench-${o.dataset}-${model}-seed${String(o.seed)}-n${String(o.sample ?? 0)}`,
  );
}

function phase(id: string, deps: BenchCommandDeps, effort?: Effort): PhaseSetup {
  const entry = findModel(loadCatalogue(), id);
  if (effort !== undefined && !entry.effort) {
    deps.log(`${id} takes no reasoning-effort setting; --effort ${effort} is ignored for it`);
  }
  return {
    provider: deps.createProvider(id),
    prices: entry,
    contextWindow: entry.contextWindow,
    ...(effort !== undefined && entry.effort ? { effort } : {}),
  };
}

/** `iaso bench`. Spec §11. */
export async function executeBench(
  opts: BenchCommandOptions,
  deps: BenchCommandDeps,
): Promise<BenchSummary> {
  if (!(DATASETS as readonly string[]).includes(opts.dataset)) {
    throw new InvalidArgumentError(
      `Unknown dataset "${opts.dataset}". Available: ${DATASETS.join(", ")}.`,
    );
  }
  if (opts.sample === undefined) {
    throw new InvalidArgumentError(
      "Give --sample <n>, the number of tasks to run. A bench costs money, so it has no default size.",
    );
  }
  const sample = opts.sample;

  // Build the model setups first: a missing API key should fail before anything is downloaded.
  const fix = phase(opts.model, deps, opts.effort);
  const plan = opts.planModel === undefined ? undefined : phase(opts.planModel, deps, opts.effort);
  const compactId = opts.compactModel ?? defaultCompactModel(loadCatalogue(), opts.model);
  const compact = compactId === opts.model ? undefined : phase(compactId, deps);

  const memory = await deps.dockerMemoryBytes();
  const needed = opts.concurrency * SANDBOX_LIMITS.memoryBytes;
  if (memory !== undefined && needed > memory) {
    deps.log(
      `warning: ${String(opts.concurrency)} sandboxes can use up to ${String(Math.round(needed / 1024 ** 3))} GB, ` +
        `but Docker has ${(memory / 1024 ** 3).toFixed(1)} GB. Lower --concurrency or give Docker more memory.`,
    );
  }

  const instances = sampleInstances(
    await deps.loadInstances(opts.refresh ?? false),
    sample,
    opts.seed,
  );
  const benchDir = resolve(opts.out ?? defaultBenchDir(opts));
  const limits: BudgetLimits = {
    maxSteps: opts.maxSteps,
    maxCostUsd: opts.maxCost,
    maxTimeMinutes: opts.maxTime,
  };
  deps.log(
    `bench: ${String(instances.length)} tasks from ${opts.dataset} (seed ${String(opts.seed)}), ` +
      `model ${opts.model}, up to $${opts.maxCost.toFixed(2)} each` +
      (opts.maxTotalCost === undefined ? "" : `, $${opts.maxTotalCost.toFixed(2)} in all`) +
      `, folder ${benchDir}`,
  );

  // The harness pulls an image it lacks for the host's own platform, which fails for these
  // x86_64-only images anywhere else. So on such a host, keep each image until it has been graded.
  const holdForGrading =
    opts.evaluate !== false && opts.keepImages !== true && deps.hostArch() !== "x64";
  if (holdForGrading) {
    deps.log(
      `this host is ${deps.hostArch()}: each task's image (about 1 GB) is kept until grading, then removed`,
    );
  }
  const summary = await runBench(
    {
      instances,
      modelName: opts.model,
      benchDir,
      limits,
      ...(opts.maxTotalCost === undefined ? {} : { maxTotalCostUsd: opts.maxTotalCost }),
      concurrency: opts.concurrency,
      usePlan: opts.plan,
      ...(opts.attempts === undefined ? {} : { attempts: opts.attempts }),
      resume: opts.resume ?? false,
      keepImages: (opts.keepImages ?? false) || holdForGrading,
    },
    {
      createSandbox: deps.createSandbox,
      fix,
      ...(plan ? { plan } : {}),
      ...(compact ? { compact } : {}),
      removeImage: deps.removeImage,
      log: deps.log,
    },
  );
  deps.log(
    `done: ${String(summary.ran)} run, ${String(summary.skipped)} skipped, ` +
      `${String(summary.submitted)} of ${String(summary.total)} submitted, $${summary.costUsd.toFixed(2)}. ` +
      `Predictions: ${join(benchDir, "predictions.jsonl")}`,
  );

  if (summary.stoppedForCost) {
    deps.log(
      `stopped early: ${String(summary.notStarted)} of ${String(summary.total)} tasks were not started ` +
        "because of --max-total-cost. Run the same command with --resume and a higher limit to do them.",
    );
  }
  const ids = new Set(instances.map((i) => i.instanceId));
  const tasks = (await readTasks(benchDir)).filter((t) => ids.has(t.instanceId));
  const resultsInput = {
    dataset: opts.dataset,
    modelName: opts.model,
    seed: opts.seed,
    tasks,
    sampled: instances.length,
  };
  const writeResults = async (report: HarnessReport | undefined): Promise<void> => {
    await writeFile(
      join(benchDir, "results.md"),
      renderResults({ ...resultsInput, report, date: new Date() }),
    );
  };

  if (opts.evaluate === false) {
    await writeResults(undefined);
    deps.log(`not graded (--no-evaluate). Results: ${join(benchDir, "results.md")}`);
    return summary;
  }
  let report: HarnessReport;
  try {
    report = await deps.evaluate({
      benchDir,
      instanceIds: [...ids],
      modelName: opts.model,
      maxWorkers: opts.concurrency,
      log: deps.log,
    });
  } catch (err) {
    if (holdForGrading) await releaseImages(deps, ids);
    // The predictions are safe on disk. Keep the agent-side numbers and say how to grade later.
    await writeResults(undefined);
    if (err instanceof HarnessError) {
      deps.log(
        `grading failed. Predictions and agent results are saved in ${benchDir}; ` +
          "run the same command with --resume to grade again.",
      );
    }
    throw err;
  }
  if (holdForGrading) await releaseImages(deps, ids);
  await writeResults(report);
  const resolved = tasks.filter((t) => report.resolved.has(t.instanceId)).length;
  deps.log(
    `resolved ${String(resolved)} of ${String(tasks.length)}. Results: ${join(benchDir, "results.md")}`,
  );
  return summary;
}

/** Remove the images held for grading. One that is already gone is not an error. */
async function releaseImages(deps: BenchCommandDeps, ids: Iterable<string>): Promise<void> {
  for (const id of ids) await deps.removeImage(instanceImage(id)).catch(() => undefined);
}

function positiveInt(name: string): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new InvalidArgumentError(`${name} must be a whole number above 0.`);
    }
    return n;
  };
}

function positive(name: string): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new InvalidArgumentError(`${name} must be a number above 0.`);
    return n;
  };
}

export function registerBench(
  program: Command,
  deps: () => BenchCommandDeps = defaultBenchDeps,
): void {
  program
    .command("bench")
    .description("Run a sample of a benchmark and write predictions.jsonl")
    .option("--dataset <name>", `dataset to sample (${DATASETS.join(", ")})`, "swebench-lite")
    .option("--sample <n>", "how many tasks to run (required)", positiveInt("--sample"))
    .option("--seed <n>", "seed for the sample, so it repeats", positiveInt("--seed"), 42)
    .option(
      "--concurrency <n>",
      "tasks at once (each sandbox may use 4 GB of RAM)",
      positiveInt("--concurrency"),
      1,
    )
    .option("--model <id>", "model for every phase", DEFAULT_MODEL)
    .option("--plan-model <id>", "model for the plan phase (default: --model)")
    .option(
      "--effort <level>",
      `reasoning effort for the plan and fix phases: ${EFFORT_LEVELS.join(", ")} (default: the model's own)`,
      parseEffort,
    )
    .option("--compact-model <id>", "model that summarises old steps")
    .option(
      "--attempts <n>",
      "attempts per task, each in a fresh sandbox within the task's cap; the first whose patch passes Iaso's check is kept",
      positiveInt("--attempts"),
      1,
    )
    .option("--no-plan", "skip the plan phase")
    .option(
      "--max-steps <n>",
      "step limit per task",
      positive("--max-steps"),
      BUDGET_DEFAULTS.maxSteps,
    )
    .option(
      "--max-cost <usd>",
      "cost limit per task, in dollars",
      positive("--max-cost"),
      BUDGET_DEFAULTS.maxCostUsd,
    )
    .option(
      "--max-time <min>",
      "time limit per task, in minutes",
      positive("--max-time"),
      BUDGET_DEFAULTS.maxTimeMinutes,
    )
    .option(
      "--max-total-cost <usd>",
      "stop starting tasks when the whole bench has spent this much (it can pass it by one model call)",
      positive("--max-total-cost"),
    )
    .option(
      "--out <dir>",
      "folder for predictions and run folders (default: named from the options)",
    )
    .option("--resume", "continue a bench folder: skip tasks that already finished")
    .option("--keep-images", "keep each instance image after its task (uses disk, saves a re-pull)")
    .option("--refresh", "read the dataset again instead of using the cached copy")
    .option("--no-evaluate", "do not grade the predictions with the SWE-bench harness")
    .action(async (opts: BenchCommandOptions) => {
      await executeBench(opts, deps());
    });
}
