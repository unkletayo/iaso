import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type PipelineResult } from "./pipeline.js";
import { renderPlan } from "./plan.js";
import { type NetworkState, describeNetwork, networkStateSchema } from "../sandbox/install.js";
import { type SecretFinding, describeFinding, secretFindingSchema } from "./secrets.js";
import { type Verification, describeCheck, verificationSchema } from "./verify.js";

export interface ReportInput {
  runId: string;
  issue: string;
  model: string;
  planModel?: string;
  /** The `--effort` given, when the model accepted it. */
  effort?: string;
  /** Where the issue and repository came from. */
  source?: { label: string; issueUrl?: string; commit?: string };
  elapsedMs: number;
  result: PipelineResult;
  /** Iaso's own check of the patch after the run (M13 step 13A). */
  verification?: Verification;
  /** Whether the sandbox network was cut after install (M13 step 13D). */
  network?: NetworkState;
  /** Set when the run made more than one attempt (M13 step 13G). */
  attempts?: AttemptsSummary;
  /** What looked like a secret in the patch (M13 step 13H). Empty when nothing did. */
  secrets?: SecretFinding[];
}

export const attemptsSummarySchema = z.object({
  kept: z.number().int().min(1),
  asked: z.number().int().min(1),
  totalCostUsd: z.number(),
  stoppedBecause: z.string().optional(),
  each: z.array(
    z.object({
      attempt: z.number().int().min(1),
      /** Absent in records made before models could vary by attempt. */
      model: z.string().optional(),
      status: z.string(),
      check: z.string(),
      costUsd: z.number(),
      steps: z.number(),
    }),
  ),
});
export type AttemptsSummary = z.infer<typeof attemptsSummarySchema>;

/**
 * `run.json`: the facts about a run that other commands (`iaso pr`) need, so they never have to read
 * them out of the prose in `report.md`. `testsRun` is what the agent noted with its `notes` tool,
 * not something Iaso checked; `verification` is what Iaso checked itself.
 */
export const runInfoSchema = z.object({
  runId: z.string(),
  model: z.string(),
  planModel: z.string().optional(),
  effort: z.string().optional(),
  status: z.string(),
  steps: z.number(),
  costUsd: z.number(),
  elapsedMs: z.number(),
  source: z
    .object({ label: z.string(), issueUrl: z.string().optional(), commit: z.string().optional() })
    .optional(),
  /** The issue's title, from the first heading of the issue text. */
  issueTitle: z.string().optional(),
  summary: z.string().optional(),
  /** Written by the agent for a pull request. Absent in runs made before prompt 1.0.1. */
  prTitle: z.string().optional(),
  prSummary: z.string().optional(),
  assumptions: z.array(z.string()).default([]),
  testsAdded: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  testsRun: z.array(z.object({ cmd: z.string(), result: z.string(), step: z.number() })),
  failedApproaches: z.array(z.object({ what: z.string(), whyItFailed: z.string() })).optional(),
  patchBytes: z.number(),
  /** Absent in runs made before step 13A. */
  verification: verificationSchema.optional(),
  /** Absent in runs made before step 13D. */
  network: networkStateSchema.optional(),
  /** Absent unless the run made more than one attempt. */
  attempts: attemptsSummarySchema.optional(),
  /** Absent in runs made before the scan existed; otherwise the findings, possibly none. */
  secrets: z.array(secretFindingSchema).optional(),
});
export type RunInfo = z.infer<typeof runInfoSchema>;

export function runInfoOf(input: ReportInput): RunInfo {
  const sub = input.result.fix?.submission;
  const title = /^#\s+(.+)$/m.exec(input.issue)?.[1]?.trim();
  return {
    runId: input.runId,
    model: input.model,
    ...(input.planModel === undefined ? {} : { planModel: input.planModel }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    status: input.result.status,
    steps: input.result.steps,
    costUsd: input.result.costUsd,
    elapsedMs: input.elapsedMs,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(title === undefined ? {} : { issueTitle: title }),
    ...(sub === undefined
      ? {}
      : {
          summary: sub.summary,
          prTitle: sub.prTitle,
          prSummary: sub.prSummary,
          confidence: sub.confidence,
        }),
    assumptions: sub?.assumptions ?? [],
    testsAdded: sub?.testsAdded ?? [],
    testsRun: input.result.fix?.state.testsRun ?? [],
    ...(input.result.fix?.state.failedApproaches.length
      ? { failedApproaches: input.result.fix.state.failedApproaches }
      : {}),
    patchBytes: Buffer.byteLength(input.result.diff),
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
  };
}

function renderVerification(v: Verification): string[] {
  const lines = [
    `status: ${v.status}`,
    "",
    `- ${describeCheck("reproduction", v.reproduction)}`,
    `- ${describeCheck("suite", v.suite)}`,
  ];
  for (const [name, check] of [
    ["reproduction", v.reproduction],
    ["suite", v.suite],
  ] as const) {
    if (check.status === "fail" && check.tail !== "") {
      lines.push("", `Last lines of the ${name} check:`, "", fence("", check.tail));
    }
  }
  return lines;
}

const fence = (lang: string, body: string): string => {
  // A diff can contain ``` itself; use a longer fence than any run of backticks inside.
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${lang}\n${body.replace(/\n$/, "")}\n${marks}`;
};

const bullets = (items: string[]): string =>
  items.length === 0 ? "(none)" : items.map((i) => `- ${i}`).join("\n");

/** Spec §8 phase 5: plan, diff, tests run and results, cost, step count. */
export function renderReport({
  runId,
  issue,
  model,
  planModel,
  effort,
  source,
  elapsedMs,
  result,
  verification,
  network,
  attempts,
  secrets,
}: ReportInput): string {
  const state = result.fix?.state;
  const sub = result.fix?.submission;
  const lines = [
    `# Iaso report: ${runId}`,
    "",
    `- status: ${result.status}${result.message ? ` (${result.message})` : ""}`,
    ...(source
      ? [
          `- source: ${source.label}${source.issueUrl ? ` (${source.issueUrl})` : ""}${source.commit ? `, commit ${source.commit}` : ""}`,
        ]
      : []),
    `- model: ${model}${planModel && planModel !== model ? `, plan model: ${planModel}` : ""}${effort === undefined ? "" : `, effort: ${effort}`}`,
    `- steps: ${String(result.steps)} (plan ${String(result.planSteps)})`,
    `- cost: $${result.costUsd.toFixed(4)} (plan $${result.planCostUsd.toFixed(4)})`,
    `- time: ${(elapsedMs / 1000).toFixed(1)}s`,
    ...(network ? [`- network: ${describeNetwork(network)}`] : []),
    "",
    "## Issue",
    "",
    issue.trim(),
    "",
    "## Plan",
    "",
    result.plan ? renderPlan(result.plan) : "(no plan: skipped or not produced)",
  ];
  if (sub) {
    lines.push("", "## Summary", "", sub.summary, "", `confidence: ${sub.confidence}`);
    lines.push("", "## Pull request text", "", `title: ${sub.prTitle}`, "", sub.prSummary);
    lines.push("", "## Assumptions", "", bullets(sub.assumptions));
    lines.push("", "## Tests added", "", bullets(sub.testsAdded));
  }
  if (state) {
    lines.push(
      "",
      "## Tests run",
      "",
      bullets(state.testsRun.map((t) => `[${t.result}] ${t.cmd} (step ${String(t.step)})`)),
      "",
      "## Failed approaches",
      "",
      bullets(state.failedApproaches.map((f) => `${f.what}: ${f.whyItFailed}`)),
    );
  }
  if (verification) {
    lines.push("", "## Checked by Iaso after the run", "", ...renderVerification(verification));
  }
  if (attempts) {
    lines.push(
      "",
      "## Attempts",
      "",
      `kept attempt ${String(attempts.kept)} of ${String(attempts.each.length)} made (${String(attempts.asked)} asked); $${attempts.totalCostUsd.toFixed(4)} in all` +
        (attempts.stoppedBecause === undefined
          ? ""
          : `; stopped early: ${attempts.stoppedBecause}`),
      "",
      ...attempts.each.map(
        (a) =>
          `- attempt ${String(a.attempt)}${a.model === undefined ? "" : ` (${a.model})`}: ${a.status}, check ${a.check}, ${String(a.steps)} steps, $${a.costUsd.toFixed(4)}` +
          (a.attempt === attempts.kept ? " (kept)" : ""),
      ),
    );
  }
  if (secrets !== undefined && secrets.length > 0) {
    lines.push(
      "",
      "## Possible secrets in the patch",
      "",
      "Do not open a pull request with these in it. Remove each one, or confirm it is not a secret:",
      "",
      bullets(secrets.map(describeFinding)),
    );
  }
  lines.push(
    "",
    "## Diff",
    "",
    result.diff.trim() === "" ? "(no changes)" : fence("diff", result.diff),
  );
  return `${lines.join("\n")}\n`;
}

/** Write `report.md`, `patch.diff` and `run.json` into the run directory. */
export async function writeReport(runDir: string, input: ReportInput): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "report.md"), renderReport(input), "utf8");
  await writeFile(join(runDir, "patch.diff"), input.result.diff, "utf8");
  await writeFile(join(runDir, "run.json"), JSON.stringify(runInfoOf(input), null, 2), "utf8");
}
