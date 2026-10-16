import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BudgetLimits } from "../config.js";
import type { Plan } from "../context/state.js";
import type { ModelProvider } from "../providers/types.js";
import type { Sandbox } from "../sandbox/types.js";
import type { ModelPrices } from "../telemetry/cost.js";
import { TrajectoryWriter } from "../telemetry/trajectory.js";
import { bashTool } from "../tools/bash.js";
import { editFileTool } from "../tools/edit-file.js";
import { notesTool } from "../tools/notes.js";
import { readFileTool } from "../tools/read-file.js";
import { FileOutputStore, makeReadOutputTool } from "../tools/read-output.js";
import { submitTool } from "../tools/submit.js";
import { Budget } from "./budget.js";
import { type LoopResult, type RunStatus, runLoop } from "./loop.js";
import { type PlanOptions, renderPlan, runPlan } from "./plan.js";
import { buildSystemPrompt } from "./prompts.js";

/** The plan phase is for reading, so it gets a smaller step cap than the whole run. */
export const PLAN_MAX_STEPS = 20;
/** The first plan, plus one more after reviewer feedback (spec §8). */
export const MAX_PLAN_ROUNDS = 2;

export type ReviewDecision =
  { kind: "approve" } | { kind: "reject" } | { kind: "feedback"; text: string };

/** Shows the plan to a person. `canRevise` is false on the last round: feedback is not honoured. */
export type PlanReviewer = (plan: Plan, canRevise: boolean) => Promise<ReviewDecision>;

export type PipelineStatus = RunStatus | "plan_failed" | "plan_rejected";

export interface PhaseSetup {
  provider: ModelProvider;
  prices: ModelPrices;
  /** Tokens. Without it the context thresholds are off. */
  contextWindow?: number;
}

export interface PipelineOptions {
  /** Model for reproduce, fix, verify and report. */
  fix: PhaseSetup;
  /** Model for the plan phase. Defaults to `fix`. */
  plan?: PhaseSetup;
  /** Model that writes summaries when the context grows. Defaults to `fix`. */
  compact?: PhaseSetup;
  sandbox: Sandbox;
  issue: string;
  limits: BudgetLimits;
  /** `runs/<runId>`: trajectories, outputs, plan.json. */
  runDir: string;
  extraRules?: readonly string[];
  /** Run the plan phase first. */
  usePlan: boolean;
  /** Asks a person about the plan. Without it the plan is accepted as is. */
  review?: PlanReviewer;
  now?: () => number;
}

export interface PipelineResult {
  status: PipelineStatus;
  message?: string;
  plan?: Plan;
  planCostUsd: number;
  planSteps: number;
  /** The fix loop. Absent when the run stopped in the plan phase. */
  fix?: LoopResult;
  /** Plan plus fix. */
  costUsd: number;
  steps: number;
  diff: string;
}

export type PlanStage =
  | { ok: true; plan: Plan; costUsd: number; steps: number }
  | {
      ok: false;
      status: "plan_failed" | "plan_rejected";
      message: string;
      costUsd: number;
      steps: number;
    };

/** What is left of the limits after the plan phase has spent some cost and time. */
function remaining(limits: BudgetLimits, spentUsd: number, elapsedMs: number): BudgetLimits {
  return {
    maxSteps: limits.maxSteps,
    maxCostUsd: Math.max(0, limits.maxCostUsd - spentUsd),
    maxTimeMinutes: Math.max(0, limits.maxTimeMinutes - elapsedMs / 60_000),
  };
}

const planTrajectory = (runDir: string, round: number): TrajectoryWriter =>
  new TrajectoryWriter(join(runDir, `plan-${String(round)}.trajectory.jsonl`));

async function savePlan(runDir: string, plan: Plan): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** Spec §8 phase 1: plan, optionally ask a person, optionally revise once. Used by `iaso plan` too. */
export async function runPlanPhase(
  o: Omit<PipelineOptions, "usePlan" | "extraRules">,
  total: Budget = new Budget(o.limits, o.now),
): Promise<PlanStage> {
  const setup = o.plan ?? o.fix;
  let costUsd = 0;
  let steps = 0;
  let feedback: PlanOptions["feedback"];
  for (let round = 1; ; round += 1) {
    const budget = new Budget(
      {
        ...remaining(o.limits, costUsd, total.elapsedMs),
        maxSteps: Math.min(o.limits.maxSteps, PLAN_MAX_STEPS),
      },
      o.now,
    );
    const { plan, result } = await runPlan({
      provider: setup.provider,
      prices: setup.prices,
      sandbox: o.sandbox,
      issue: o.issue,
      budget,
      trajectory: planTrajectory(o.runDir, round),
      ...(feedback ? { feedback } : {}),
    });
    costUsd += result.costUsd;
    steps += result.steps;
    if (!plan) {
      const message = result.message ?? `The planner ended without a plan (${result.status}).`;
      return { ok: false, status: "plan_failed", message, costUsd, steps };
    }
    await savePlan(o.runDir, plan);
    if (!o.review) return { ok: true, plan, costUsd, steps };

    const canRevise = round < MAX_PLAN_ROUNDS;
    const decision = await o.review(plan, canRevise);
    if (decision.kind === "approve") return { ok: true, plan, costUsd, steps };
    if (decision.kind === "reject" || !canRevise) {
      return {
        ok: false,
        status: "plan_rejected",
        message: "The plan was not approved.",
        costUsd,
        steps,
      };
    }
    feedback = { previous: plan, text: decision.text };
  }
}

/** Plan (unless skipped), then run the fix loop with the plan pinned. */
export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const total = new Budget(o.limits, o.now);
  let plan: Plan | undefined;
  let planCostUsd = 0;
  let planSteps = 0;
  if (o.usePlan) {
    const stage = await runPlanPhase(o, total);
    planCostUsd = stage.costUsd;
    planSteps = stage.steps;
    if (!stage.ok) {
      return {
        status: stage.status,
        message: stage.message,
        planCostUsd,
        planSteps,
        costUsd: planCostUsd,
        steps: planSteps,
        diff: "",
      };
    }
    plan = stage.plan;
  }

  const outputs = new FileOutputStore(join(o.runDir, "outputs"));
  const fix = await runLoop({
    provider: o.fix.provider,
    prices: o.fix.prices,
    ...(o.fix.contextWindow === undefined ? {} : { contextWindow: o.fix.contextWindow }),
    compaction: { provider: (o.compact ?? o.fix).provider, prices: (o.compact ?? o.fix).prices },
    sandbox: o.sandbox,
    tools: [
      bashTool,
      readFileTool,
      editFileTool,
      notesTool,
      makeReadOutputTool(outputs),
      submitTool,
    ],
    systemPrompt: buildSystemPrompt(o.extraRules),
    issue: o.issue,
    ...(plan ? { plan: renderPlan(plan) } : {}),
    budget: new Budget(remaining(o.limits, planCostUsd, total.elapsedMs), o.now),
    trajectory: new TrajectoryWriter(join(o.runDir, "trajectory.jsonl")),
    outputs,
  });
  return {
    status: fix.status,
    ...(fix.message === undefined ? {} : { message: fix.message }),
    ...(plan ? { plan } : {}),
    planCostUsd,
    planSteps,
    fix,
    costUsd: planCostUsd + fix.costUsd,
    steps: planSteps + fix.steps,
    diff: fix.diff,
  };
}
