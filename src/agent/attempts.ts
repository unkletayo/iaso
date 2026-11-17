import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BudgetLimits } from "../config.js";
import type { Plan } from "../context/state.js";
import { type NetworkState, OFFLINE_RULE } from "../sandbox/install.js";
import type { Sandbox } from "../sandbox/types.js";
import { type PipelineOptions, type PipelineResult, runPipeline } from "./pipeline.js";
import { type Verification, notVerified, verifyRun } from "./verify.js";

/**
 * M13 step 13G: several attempts at one issue, each in a fresh sandbox, sharing the run's cost
 * and time budget. The run stops at the first attempt whose patch passes the post-run check
 * (13A); otherwise the attempt with the best check result is kept. Attempts are independent
 * samples of the same model: nothing from a failed attempt is shown to the next one.
 */

export interface AttemptRecord {
  attempt: number;
  /** Where this attempt's trajectory, outputs and plan are. */
  dir: string;
  result: PipelineResult;
  verification: Verification;
  network: NetworkState;
}

export interface AttemptsOutcome {
  kept: AttemptRecord;
  attempts: AttemptRecord[];
  /** Cost of every attempt together. */
  totalCostUsd: number;
  /** Why no further attempt was started, when fewer ran than were asked for. */
  stoppedBecause?: string;
}

export interface AttemptsOptions {
  /** How many attempts at most. 1 is a plain run. */
  attempts: number;
  limits: BudgetLimits;
  /** `runs/<runId>`. With one attempt it is used as is; with more, each attempt gets a subfolder. */
  runDir: string;
  /** A sandbox for the attempt, not started. Each attempt gets its own. */
  createSandbox: (attempt: number) => Sandbox;
  /** Runs after `start()`: install, cut the network. Its result is recorded with the attempt. */
  prepare: (sandbox: Sandbox) => Promise<NetworkState>;
  pipeline: Omit<PipelineOptions, "sandbox" | "limits" | "runDir" | "approvedPlan">;
  /** `.iaso.json` `testCommand`, for the post-run check. */
  testCommand?: string | undefined;
  log: (line: string) => void;
  now?: () => number;
}

/** Below this much of the cost limit, another attempt is not worth starting. */
const MIN_COST_SHARE = 0.1;

/** Higher is better. The first attempt to reach `verified` ends the run. */
export function rank(record: Pick<AttemptRecord, "result" | "verification">): number {
  if (record.result.status !== "submitted") return 0;
  switch (record.verification.status) {
    case "verified":
      return 3;
    case "not_checked":
      return 2;
    case "failed":
      return 1;
  }
}

export const attemptDir = (runDir: string, attempt: number, attempts: number): string =>
  attempts === 1 ? runDir : join(runDir, `attempt-${String(attempt)}`);

function remaining(limits: BudgetLimits, spentUsd: number, elapsedMs: number): BudgetLimits {
  return {
    maxSteps: limits.maxSteps,
    maxCostUsd: Math.max(0, limits.maxCostUsd - spentUsd),
    maxTimeMinutes: Math.max(0, limits.maxTimeMinutes - elapsedMs / 60_000),
  };
}

async function runOne(
  o: AttemptsOptions,
  attempt: number,
  limits: BudgetLimits,
  approvedPlan: Plan | undefined,
): Promise<AttemptRecord> {
  const dir = attemptDir(o.runDir, attempt, o.attempts);
  const sandbox = o.createSandbox(attempt);
  try {
    // Inside the try, so a sandbox that fails to start is still cleaned up (`destroy` is idempotent).
    await sandbox.start();
    const network = await o.prepare(sandbox);
    const extraRules = o.pipeline.extraRules ?? [];
    const result = await runPipeline({
      ...o.pipeline,
      extraRules: network.network === "off" ? [...extraRules, OFFLINE_RULE] : extraRules,
      sandbox,
      limits,
      runDir: dir,
      ...(approvedPlan === undefined ? {} : { approvedPlan }),
    });
    // The diff is already in `result`, so the check cannot change the patch that gets written.
    if (result.status === "submitted") o.log(`attempt ${String(attempt)}: checking the patch`);
    const verification =
      result.status === "submitted"
        ? // A check that breaks must not cost the report and patch the attempt already paid for.
          await verifyRun({
            sandbox,
            testsRun: result.fix?.state.testsRun ?? [],
            testsAdded: result.fix?.submission?.testsAdded ?? [],
            testCommand: o.testCommand,
          }).catch((err: unknown) =>
            notVerified(
              `the check itself failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        : notVerified(`the run ended with status ${result.status}`);
    return { attempt, dir, result, verification, network };
  } finally {
    await sandbox.destroy();
  }
}

/**
 * Run up to `attempts` attempts and pick one. The plan of the first attempt that made one is
 * reused by the later attempts, so a reviewer is asked once and the plan phase is paid once.
 */
export async function runAttempts(o: AttemptsOptions): Promise<AttemptsOutcome> {
  const now = o.now ?? Date.now;
  const started = now();
  const records: AttemptRecord[] = [];
  let spent = 0;
  let approvedPlan: Plan | undefined;
  let stoppedBecause: string | undefined;

  for (let attempt = 1; attempt <= o.attempts; attempt += 1) {
    const limits = remaining(o.limits, spent, now() - started);
    if (attempt > 1 && limits.maxCostUsd < o.limits.maxCostUsd * MIN_COST_SHARE) {
      stoppedBecause = `only $${limits.maxCostUsd.toFixed(2)} of the cost limit was left`;
      break;
    }
    if (attempt > 1 && limits.maxTimeMinutes <= 0) {
      stoppedBecause = "the time limit was reached";
      break;
    }
    if (o.attempts > 1) o.log(`attempt ${String(attempt)} of ${String(o.attempts)}`);
    const record = await runOne(o, attempt, limits, approvedPlan);
    records.push(record);
    spent += record.result.costUsd;
    if (record.result.status === "plan_rejected") {
      stoppedBecause = "the plan was not approved";
      break;
    }
    if (record.verification.status === "verified") break;
    approvedPlan ??= record.result.plan;
  }

  const kept = records.reduce((best, r) => (rank(r) > rank(best) ? r : best));
  if (o.attempts > 1) {
    // `iaso replay` and `iaso pr` read the run folder itself, so the kept attempt's files go there.
    await mkdir(o.runDir, { recursive: true });
    await cp(kept.dir, o.runDir, { recursive: true, force: true });
  }
  return {
    kept,
    attempts: records,
    totalCostUsd: spent,
    ...(stoppedBecause === undefined ? {} : { stoppedBecause }),
  };
}
