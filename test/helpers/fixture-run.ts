import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Budget } from "../../src/agent/budget.js";
import { type PipelineResult, runPipeline } from "../../src/agent/pipeline.js";
import { type LoopResult, runLoop } from "../../src/agent/loop.js";
import { buildSystemPrompt } from "../../src/agent/prompts.js";
import { BUDGET_DEFAULTS, type BudgetLimits } from "../../src/config.js";
import { findModel, loadCatalogue } from "../../src/models.js";
import type { ModelProvider } from "../../src/providers/types.js";
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { TrajectoryWriter } from "../../src/telemetry/trajectory.js";
import { bashTool } from "../../src/tools/bash.js";
import { editFileTool } from "../../src/tools/edit-file.js";
import { notesTool } from "../../src/tools/notes.js";
import { readFileTool } from "../../src/tools/read-file.js";
import { FileOutputStore, makeReadOutputTool } from "../../src/tools/read-output.js";
import { submitTool } from "../../src/tools/submit.js";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/off-by-one", import.meta.url));

export interface FixtureRun {
  result: LoopResult;
  /** Exit code of `node --test` in the sandbox after the run. */
  testExitCode: number;
  trajectoryPath: string;
}

/** Run the agent on the off-by-one fixture in a real Docker sandbox. */
export async function runOnFixture(
  provider: ModelProvider,
  modelId: string,
  label: string,
  budget: Budget = new Budget({ ...BUDGET_DEFAULTS, maxCostUsd: 0.5, maxSteps: 30 }),
): Promise<FixtureRun> {
  const dir = await mkdtemp(join(tmpdir(), "iaso-fixture-run-"));
  const trajectoryPath = join(dir, "trajectory.jsonl");
  const issue = await readFile(join(FIXTURE_DIR, "ISSUE.md"), "utf8");
  const model = findModel(loadCatalogue(), modelId);
  const sandbox = new DockerSandbox({
    runId: `${label}-${String(Date.now())}`,
    repoPath: FIXTURE_DIR,
  });
  await sandbox.start();
  try {
    const outputs = new FileOutputStore(join(dir, "outputs"));
    const result = await runLoop({
      provider,
      prices: model,
      sandbox,
      tools: [
        bashTool,
        readFileTool,
        editFileTool,
        notesTool,
        makeReadOutputTool(outputs),
        submitTool,
      ],
      systemPrompt: buildSystemPrompt(),
      issue,
      budget,
      trajectory: new TrajectoryWriter(trajectoryPath),
      outputs,
    });
    const tests = await sandbox.exec("node --test");
    return { result, testExitCode: tests.exitCode, trajectoryPath };
  } finally {
    await sandbox.destroy();
  }
}

export interface FixturePipelineRun {
  result: PipelineResult;
  testExitCode: number;
  runDir: string;
}

/** Plan, then fix, on the off-by-one fixture in a real Docker sandbox. */
export async function runPipelineOnFixture(
  provider: ModelProvider,
  modelId: string,
  label: string,
  limits: BudgetLimits = { ...BUDGET_DEFAULTS, maxCostUsd: 0.5, maxSteps: 40 },
): Promise<FixturePipelineRun> {
  const runDir = await mkdtemp(join(tmpdir(), "iaso-fixture-pipeline-"));
  const issue = await readFile(join(FIXTURE_DIR, "ISSUE.md"), "utf8");
  const model = findModel(loadCatalogue(), modelId);
  const sandbox = new DockerSandbox({
    runId: `${label}-${String(Date.now())}`,
    repoPath: FIXTURE_DIR,
  });
  await sandbox.start();
  try {
    const result = await runPipeline({
      fix: { provider, prices: model, contextWindow: model.contextWindow },
      sandbox,
      issue,
      limits,
      runDir,
      usePlan: true,
    });
    const tests = await sandbox.exec("node --test");
    return { result, testExitCode: tests.exitCode, runDir };
  } finally {
    await sandbox.destroy();
  }
}
