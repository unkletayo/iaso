import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Command, InvalidArgumentError } from "commander";
import {
  type PhaseSetup,
  type PlanReviewer,
  type ReviewDecision,
  runPipeline,
  runPlanPhase,
} from "../agent/pipeline.js";
import { renderPlan } from "../agent/plan.js";
import { writeReport } from "../agent/report.js";
import { BUDGET_DEFAULTS, type BudgetLimits, loadConfig } from "../config.js";
import { findModel, loadCatalogue } from "../models.js";
import type { ModelProvider } from "../providers/types.js";
import { createProvider } from "../providers/registry.js";
import { DockerSandbox } from "../sandbox/docker.js";
import type { Sandbox } from "../sandbox/types.js";

export const DEFAULT_MODEL = "anthropic:claude-sonnet-5-5";

export interface RunCommandOptions {
  repo: string;
  issue: string;
  model: string;
  planModel?: string;
  approvePlan?: boolean;
  /** False with `--no-plan`. */
  plan: boolean;
  maxSteps: number;
  maxCost: number;
  maxTime: number;
  runs: string;
  config?: string;
}

/** Everything the command touches outside itself, so tests can swap it. */
export interface CommandDeps {
  createProvider: (id: string) => ModelProvider;
  createSandbox: (o: { runId: string; repoPath: string; image?: string }) => Sandbox;
  review: PlanReviewer;
  log: (line: string) => void;
}

/** `y` approves, `n` rejects, anything else is feedback. Null means ask again. */
export function parseReview(answer: string, canRevise: boolean): ReviewDecision | null {
  const text = answer.trim();
  if (/^y(es)?$/i.test(text)) return { kind: "approve" };
  if (/^n(o)?$/i.test(text)) return { kind: "reject" };
  if (text === "" || !canRevise) return null;
  return { kind: "feedback", text };
}

function terminalReviewer(log: (line: string) => void): PlanReviewer {
  return async (plan, canRevise) => {
    log(`\n${renderPlan(plan)}\n`);
    const question = canRevise
      ? "Approve this plan? [y]es / [n]o / or type feedback: "
      : "Approve this plan? [y]es / [n]o: ";
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (;;) {
        const decision = parseReview(await rl.question(question), canRevise);
        if (decision) return decision;
      }
    } finally {
      rl.close();
    }
  };
}

export function defaultDeps(): CommandDeps {
  const log = (line: string): void => {
    console.log(line);
  };
  return {
    createProvider: (id) => createProvider(id),
    createSandbox: ({ runId, repoPath, image }) =>
      new DockerSandbox({ runId, repoPath, ...(image === undefined ? {} : { image }) }),
    review: terminalReviewer(log),
    log,
  };
}

export const newRunId = (now: Date = new Date()): string =>
  `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(2).toString("hex")}`;

function setupFor(id: string, deps: CommandDeps): PhaseSetup {
  return { provider: deps.createProvider(id), prices: findModel(loadCatalogue(), id) };
}

/** `iaso run` and `iaso plan`. Spec §8. */
export async function executeCommand(
  mode: "run" | "plan",
  opts: RunCommandOptions,
  deps: CommandDeps,
): Promise<void> {
  const repo = resolve(opts.repo);
  const issue = await readFile(resolve(opts.issue), "utf8");
  const config = loadConfig(repo, opts.config);
  const fix = setupFor(opts.model, deps);
  const plan = opts.planModel === undefined ? fix : setupFor(opts.planModel, deps);
  const limits: BudgetLimits = {
    maxSteps: opts.maxSteps,
    maxCostUsd: opts.maxCost,
    maxTimeMinutes: opts.maxTime,
  };
  const runId = newRunId();
  const runDir = join(resolve(opts.runs), runId);
  const started = Date.now();
  const review = opts.approvePlan ? deps.review : undefined;

  deps.log(`run ${runId}: starting sandbox`);
  const sandbox = deps.createSandbox({
    runId,
    repoPath: repo,
    ...(config.image === undefined ? {} : { image: config.image }),
  });
  await sandbox.start();
  try {
    if (mode === "plan") {
      const stage = await runPlanPhase({
        fix,
        plan,
        sandbox,
        issue,
        limits,
        runDir,
        ...(review ? { review } : {}),
      });
      if (!stage.ok) throw new Error(`${stage.status}: ${stage.message}`);
      deps.log(
        `${renderPlan(stage.plan)}\n\nplan cost: $${stage.costUsd.toFixed(4)}, saved to ${join(runDir, "plan.json")}`,
      );
      return;
    }
    const result = await runPipeline({
      fix,
      plan,
      sandbox,
      issue,
      limits,
      runDir,
      extraRules: config.extraRules,
      usePlan: opts.plan,
      ...(review ? { review } : {}),
    });
    await writeReport(runDir, {
      runId,
      issue,
      model: opts.model,
      ...(opts.planModel === undefined ? {} : { planModel: opts.planModel }),
      elapsedMs: Date.now() - started,
      result,
    });
    deps.log(
      `${result.status}: ${String(result.steps)} steps, $${result.costUsd.toFixed(4)}. Report: ${join(runDir, "report.md")}, patch: ${join(runDir, "patch.diff")}`,
    );
    if (result.status !== "submitted") {
      throw new Error(
        `Run ended with status ${result.status}${result.message ? `: ${result.message}` : ""}`,
      );
    }
  } finally {
    await sandbox.destroy();
  }
}

function positive(name: string): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new InvalidArgumentError(`${name} must be a number above 0.`);
    return n;
  };
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--repo <path>", "repository to fix (copied into the sandbox)")
    .requiredOption("--issue <file>", "file with the bug report")
    .option("--model <id>", "model for reproduce, fix, verify", DEFAULT_MODEL)
    .option("--plan-model <id>", "model for the plan phase (default: --model)")
    .option("--max-steps <n>", "step limit", positive("--max-steps"), BUDGET_DEFAULTS.maxSteps)
    .option(
      "--max-cost <usd>",
      "cost limit in dollars",
      positive("--max-cost"),
      BUDGET_DEFAULTS.maxCostUsd,
    )
    .option(
      "--max-time <min>",
      "time limit in minutes",
      positive("--max-time"),
      BUDGET_DEFAULTS.maxTimeMinutes,
    )
    .option("--runs <dir>", "where run folders go", "runs")
    .option("--config <file>", "path to .iaso.json");
}

export function registerRun(program: Command, deps: () => CommandDeps = defaultDeps): void {
  addCommonOptions(program.command("run").description("Fix a bug from an issue and a repository"))
    .option("--approve-plan", "show the plan and wait for y, n, or feedback")
    .option("--no-plan", "skip the plan phase")
    .action(async (opts: RunCommandOptions) => {
      await executeCommand("run", opts, deps());
    });

  addCommonOptions(
    program.command("plan").description("Run only the planning phase and print the plan"),
  )
    .option("--approve-plan", "wait for y, n, or feedback before exiting")
    .action(async (opts: Omit<RunCommandOptions, "plan">) => {
      await executeCommand("plan", { ...opts, plan: true }, deps());
    });
}
