import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

/** Write `report.md` and `patch.diff` into the run directory. */
export async function writeReport(runDir: string, input: ReportInput): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "report.md"), renderReport(input), "utf8");
  await writeFile(join(runDir, "patch.diff"), input.result.diff, "utf8");
}
