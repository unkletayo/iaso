import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type PipelineResult } from "./pipeline.js";
import { renderPlan } from "./plan.js";

export interface ReportInput {
  runId: string;
  issue: string;
  model: string;
  planModel?: string;
  /** Where the issue and repository came from. */
  source?: { label: string; issueUrl?: string; commit?: string };
  elapsedMs: number;
  result: PipelineResult;
}

/**
 * `run.json`: the facts about a run that other commands (`iaso pr`) need, so they never have to read
 * them out of the prose in `report.md`. `testsRun` is what the agent noted with its `notes` tool,
 * not something Iaso checked.
 */
export const runInfoSchema = z.object({
  runId: z.string(),
  model: z.string(),
  planModel: z.string().optional(),
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
  patchBytes: z.number(),
});
export type RunInfo = z.infer<typeof runInfoSchema>;

export function runInfoOf(input: ReportInput): RunInfo {
  const sub = input.result.fix?.submission;
  const title = /^#\s+(.+)$/m.exec(input.issue)?.[1]?.trim();
  return {
    runId: input.runId,
    model: input.model,
    ...(input.planModel === undefined ? {} : { planModel: input.planModel }),
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
    patchBytes: Buffer.byteLength(input.result.diff),
  };
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
  source,
  elapsedMs,
  result,
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
    `- model: ${model}${planModel && planModel !== model ? `, plan model: ${planModel}` : ""}`,
    `- steps: ${String(result.steps)} (plan ${String(result.planSteps)})`,
    `- cost: $${result.costUsd.toFixed(4)} (plan $${result.planCostUsd.toFixed(4)})`,
    `- time: ${(elapsedMs / 1000).toFixed(1)}s`,
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
