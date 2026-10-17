import { randomBytes } from "node:crypto";
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
import { BUDGET_DEFAULTS, type BudgetLimits, IasoConfigSchema, loadConfig } from "../config.js";
import { type Catalogue, findModel, loadCatalogue } from "../models.js";
import type { ModelProvider } from "../providers/types.js";
import { createProvider } from "../providers/registry.js";
import { DockerSandbox } from "../sandbox/docker.js";
import type { Sandbox } from "../sandbox/types.js";
import { githubSource } from "../sources/github.js";
import { SourceError, localSource } from "../sources/local.js";
import type { Source } from "../sources/types.js";

export const DEFAULT_MODEL = "anthropic:claude-sonnet-5-5";

export interface RunCommandOptions {
  repo?: string;
  issue?: string;
  /** A GitHub issue URL. Replaces `repo` and `issue`. */
  github?: string;
  model: string;
  planModel?: string;
  compactModel?: string;
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
  resolveSource: (o: SourceChoice) => Promise<Source>;
  createProvider: (id: string) => ModelProvider;
  createSandbox: (o: { runId: string; repoPath: string; image?: string }) => Sandbox;
  review: PlanReviewer;
  log: (line: string) => void;
}

export type SourceChoice =
  { kind: "local"; repo: string; issue: string } | { kind: "github"; url: string };

/** Exactly one of `--github` or `--repo` with `--issue`. */
export function chooseSource(
  opts: Pick<RunCommandOptions, "repo" | "issue" | "github">,
): SourceChoice {
  const { repo, issue, github } = opts;
  if (github !== undefined) {
    if (repo !== undefined || issue !== undefined) {
      throw new SourceError("Use --github alone, or --repo with --issue, not both.");
    }
    return { kind: "github", url: github };
  }
  if (repo === undefined || issue === undefined) {
    throw new SourceError("Give --github <issue url>, or both --repo and --issue.");
  }
  return { kind: "local", repo, issue };
}

/** The real sources. `GITHUB_TOKEN` is optional and stays on the host. */
export function defaultResolveSource(choice: SourceChoice): Promise<Source> {
  if (choice.kind === "local") return localSource(choice);
  const token = process.env.GITHUB_TOKEN;
  return githubSource(choice.url, token ? { token } : {});
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
    resolveSource: defaultResolveSource,
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
  const entry = findModel(loadCatalogue(), id);
  return { provider: deps.createProvider(id), prices: entry, contextWindow: entry.contextWindow };
}

/** The cheapest tool-calling model of the same provider, by input plus output price. */
export function defaultCompactModel(catalogue: Catalogue, modelId: string): string {
  const main = findModel(catalogue, modelId);
  const cheapest = catalogue.models
    .filter((m) => m.provider === main.provider && m.toolCalls)
    .sort((a, b) => a.inputPrice + a.outputPrice - (b.inputPrice + b.outputPrice))[0];
  return cheapest?.id ?? main.id;
}

/** `iaso run` and `iaso plan`. Spec §8. */
export async function executeCommand(
  mode: "run" | "plan",
  opts: RunCommandOptions,
  deps: CommandDeps,
): Promise<void> {
  const choice = chooseSource(opts);
  const fix = setupFor(opts.model, deps);
  const plan = opts.planModel === undefined ? fix : setupFor(opts.planModel, deps);
  const limits: BudgetLimits = {
    maxSteps: opts.maxSteps,
    maxCostUsd: opts.maxCost,
    maxTimeMinutes: opts.maxTime,
  };
  const compactId = opts.compactModel ?? defaultCompactModel(loadCatalogue(), opts.model);
  const compact = compactId === opts.model ? fix : setupFor(compactId, deps);
  const runId = newRunId();
  const runDir = join(resolve(opts.runs), runId);
  const started = Date.now();
  const review = opts.approvePlan ? deps.review : undefined;

  deps.log(`run ${runId}: getting the source`);
  const source = await deps.resolveSource(choice);
  try {
    await runWithSource(mode, opts, deps, {
      source,
      fix,
      plan,
      compact,
      limits,
      runId,
      runDir,
      started,
      review,
    });
  } finally {
    await source.cleanup();
  }
}

interface Prepared {
  source: Source;
  fix: PhaseSetup;
  plan: PhaseSetup;
  compact: PhaseSetup;
  limits: BudgetLimits;
  runId: string;
  runDir: string;
  started: number;
  review: PlanReviewer | undefined;
}

async function runWithSource(
  mode: "run" | "plan",
  opts: RunCommandOptions,
  deps: CommandDeps,
  p: Prepared,
): Promise<void> {
  const { source, fix, plan, compact, limits, runId, runDir, started, review } = p;
  const issue = source.issue;
  // A cloned repo is not trusted: its .iaso.json could pick the Docker image or add prompt rules.
  // Only a config the user names with --config applies to it.
  const config =
    opts.github !== undefined && opts.config === undefined
      ? IasoConfigSchema.parse({})
      : loadConfig(source.repoPath, opts.config);
  deps.log(`source: ${source.label}${source.commit ? ` @ ${source.commit.slice(0, 12)}` : ""}`);
  deps.log(`run ${runId}: starting sandbox`);
  const sandbox = deps.createSandbox({
    runId,
    repoPath: source.repoPath,
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
      compact,
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
      source: {
        label: source.label,
        ...(source.issueUrl === undefined ? {} : { issueUrl: source.issueUrl }),
        ...(source.commit === undefined ? {} : { commit: source.commit }),
      },
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
    .option("--repo <path>", "repository to fix (copied into the sandbox); needs --issue")
    .option("--issue <file>", "file with the bug report; needs --repo")
    .option(
      "--github <url>",
      "GitHub issue URL: reads the issue and clones the repo (GITHUB_TOKEN optional)",
    )
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
    .option(
      "--compact-model <id>",
      "model that summarises old steps (default: cheapest of the main model's provider)",
    )
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
