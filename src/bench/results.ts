import { join } from "node:path";
import { type HarnessReport, type Outcome, outcomeOf } from "./harness.js";
import type { TaskRecord } from "./runner.js";

export interface ResultsInput {
  dataset: string;
  modelName: string;
  seed: number;
  tasks: readonly TaskRecord[];
  /** Absent when grading was skipped or failed: every task is then "not graded". */
  report: HarnessReport | undefined;
  /** For the header only. */
  date?: Date;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : sum(xs) / xs.length);
const max = (xs: readonly number[]): number => (xs.length === 0 ? 0 : Math.max(...xs));
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;
const percent = (part: number, whole: number): string =>
  whole === 0 ? "0%" : `${((100 * part) / whole).toFixed(0)}%`;

/** A table cell: no pipes or line breaks, and not too long. */
function cell(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

const OUTCOME_ORDER: readonly Outcome[] = [
  "resolved",
  "unresolved",
  "empty patch",
  "error",
  "infrastructure failure",
  "incomplete",
  "not graded",
];

/** Spec §11: pass rate, cost and steps per task, and the failures with links to their trajectories. */
export function renderResults(i: ResultsInput): string {
  const total = i.tasks.length;
  const outcomes = new Map(i.tasks.map((t) => [t.instanceId, outcomeOf(t.instanceId, i.report)]));
  const count = (o: Outcome): number => [...outcomes.values()].filter((x) => x === o).length;
  const resolved = count("resolved");
  const graded = total - count("not graded");
  const costs = i.tasks.map((t) => t.costUsd);
  const steps = i.tasks.map((t) => t.steps);
  const times = i.tasks.map((t) => t.durationMs);

  const lines: string[] = [
    `# Benchmark results: ${i.dataset}`,
    "",
    `- model: ${i.modelName}`,
    `- seed: ${String(i.seed)}, ${String(total)} tasks`,
    ...(i.date ? [`- date: ${i.date.toISOString().slice(0, 10)}`] : []),
    i.report
      ? `- **resolved: ${String(resolved)} of ${String(total)} (${percent(resolved, total)})**`
      : "- **not graded**: the SWE-bench harness did not run or did not finish. Predictions are in `predictions.jsonl`.",
    ...(i.report && graded < total
      ? [`- ${String(total - graded)} of ${String(total)} tasks have no grade`]
      : []),
    "",
    "## Cost per task",
    "",
    "| mean | median | max | total |",
    "| --- | --- | --- | --- |",
    `| ${usd(mean(costs))} | ${usd(median(costs))} | ${usd(max(costs))} | ${usd(sum(costs))} |`,
    "",
    "## Steps and time per task",
    "",
    "| | mean | median | max |",
    "| --- | --- | --- | --- |",
    `| steps | ${mean(steps).toFixed(1)} | ${median(steps).toFixed(1)} | ${String(max(steps))} |`,
    `| time | ${minutes(mean(times))} | ${minutes(median(times))} | ${minutes(max(times))} |`,
    "",
    "## Outcomes",
    "",
    "| outcome | tasks |",
    "| --- | --- |",
    ...OUTCOME_ORDER.filter((o) => count(o) > 0).map((o) => `| ${o} | ${String(count(o))} |`),
    "",
  ];

  const failures = i.tasks.filter((t) => outcomes.get(t.instanceId) !== "resolved");
  lines.push("## Failures", "");
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    lines.push(
      "| task | outcome | agent status | steps | cost | run | harness log |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const t of failures) {
      const trajectory = `[run folder](${join(t.runDir, "/")})`;
      const log =
        i.report && outcomes.get(t.instanceId) !== "not graded"
          ? `[log](${join(i.report.instanceLogs, t.instanceId, "test_output.txt")})`
          : "";
      const status = t.message ? `${t.status}: ${t.message}` : t.status;
      lines.push(
        `| ${t.instanceId} | ${outcomes.get(t.instanceId) ?? "not graded"} | ${cell(status)} | ` +
          `${String(t.steps)} | ${usd(t.costUsd)} | ${trajectory} | ${log} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
