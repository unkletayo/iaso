import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { type Command, InvalidArgumentError } from "commander";
import { type PhaseSetup } from "../agent/pipeline.js";
import { writeReport } from "../agent/report.js";
import { BUDGET_DEFAULTS, IasoConfigSchema, loadConfig } from "../config.js";
import { loadCatalogue } from "../models.js";
import {
  AiPolicyError,
  aiBanMessage,
  describeConventions,
  readConventions,
} from "../oss/conventions.js";
import { IssueClaimedError, checkIssueClaim, claimMessage, describeClaim } from "../oss/claim.js";
import { createProvider } from "../providers/registry.js";
import type { ModelProvider } from "../providers/types.js";
import { DockerSandbox } from "../sandbox/docker.js";
import type { Sandbox } from "../sandbox/types.js";
import { parseIssueUrl } from "../sources/github.js";
import type { Source } from "../sources/types.js";
import { createSession, type Session, type SessionEvent } from "../core/session.js";
import type { PipelineResult } from "../agent/pipeline.js";
import {
  DEFAULT_MODEL,
  type CommandDeps,
  type RunCommandOptions,
  chooseSource,
  defaultCompactModel,
  defaultResolveSource,
  newRunId,
  setupFor,
} from "./run.js";

// ── Wire format ──────────────────────────────────────────────────────────────

export type ServePart =
  | { kind: "text"; step: number; delta: string }
  | { kind: "tool_call"; step: number; id: string; name: string; input: unknown }
  | { kind: "tool_result"; step: number; id: string; name: string; output: string; error: boolean }
  | { kind: "context"; step: number; type: "compacted" | "loop_detected" | "stuck" };

export interface AwaitRequest {
  id: string;
  name: string;
  input: unknown;
}

export type ServeEvent =
  | { type: "run.created"; run_id: string; status: "created" }
  | { type: "run.in-progress"; run_id: string; status: "in-progress" }
  | { type: "message.part"; run_id: string; part: ServePart }
  | { type: "run.awaiting"; run_id: string; status: "awaiting"; await: AwaitRequest }
  | { type: "run.completed"; run_id: string; status: "completed"; result: PipelineResult }
  | { type: "run.failed"; run_id: string; status: "failed"; message: string }
  | { type: "run.cancelled"; run_id: string; status: "cancelled" };

export type ServeControl =
  | { kind: "approve"; id: string }
  | { kind: "reject"; id: string; reason?: string }
  | { kind: "cancel" };

// ── Deps ─────────────────────────────────────────────────────────────────────

export interface ServeDeps {
  checkClaim: CommandDeps["checkClaim"];
  resolveSource: CommandDeps["resolveSource"];
  createProvider: (id: string) => ModelProvider;
  createSandbox: (o: { runId: string; repoPath: string; image?: string }) => Sandbox;
  /** Progress messages — goes to stderr in production so stdout stays JSON-only. */
  log: (line: string) => void;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export function defaultServeDeps(): ServeDeps {
  return {
    checkClaim: (url) => checkIssueClaim(parseIssueUrl(url), { token: process.env.GITHUB_TOKEN }),
    resolveSource: defaultResolveSource,
    createProvider: (id) => createProvider(id),
    createSandbox: ({ runId, repoPath, image }) =>
      new DockerSandbox({ runId, repoPath, ...(image === undefined ? {} : { image }) }),
    log: (line) => process.stderr.write(`${line}\n`),
    stdin: process.stdin,
    stdout: process.stdout,
  };
}

// ── Options ───────────────────────────────────────────────────────────────────

export type ServeCommandOptions = Omit<RunCommandOptions, "approvePlan"> & { stdio: boolean };

// ── Event translation ─────────────────────────────────────────────────────────

export function translateEvent(
  runId: string,
  event: SessionEvent,
  seenFirstStep: { value: boolean },
): ServeEvent | null {
  switch (event.kind) {
    case "step_started":
      if (!seenFirstStep.value) {
        seenFirstStep.value = true;
        return { type: "run.in-progress", run_id: runId, status: "in-progress" };
      }
      return null;
    case "text_delta":
      return {
        type: "message.part",
        run_id: runId,
        part: { kind: "text", step: event.step, delta: event.delta },
      };
    case "tool_call":
      return {
        type: "message.part",
        run_id: runId,
        part: {
          kind: "tool_call",
          step: event.step,
          id: event.id,
          name: event.name,
          input: event.input,
        },
      };
    case "tool_result":
      return {
        type: "message.part",
        run_id: runId,
        part: {
          kind: "tool_result",
          step: event.step,
          id: event.id,
          name: event.name,
          output: event.output,
          error: event.error,
        },
      };
    case "approval_requested":
      return {
        type: "run.awaiting",
        run_id: runId,
        status: "awaiting",
        await: { id: event.id, name: event.name, input: event.input },
      };
    case "context_event":
      return {
        type: "message.part",
        run_id: runId,
        part: { kind: "context", step: event.step, type: event.type },
      };
    case "finished": {
      const { result } = event;
      if (result.status === "submitted") {
        return { type: "run.completed", run_id: runId, status: "completed", result };
      }
      if (result.status === "cancelled") {
        return { type: "run.cancelled", run_id: runId, status: "cancelled" };
      }
      return {
        type: "run.failed",
        run_id: runId,
        status: "failed",
        message: result.message ?? result.status,
      };
    }
  }
}

// ── Stdin control reader ──────────────────────────────────────────────────────

export function startControlReader(stdin: NodeJS.ReadableStream, session: Session): () => void {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const ctrl = JSON.parse(trimmed) as ServeControl;
      session.send(ctrl);
    } catch {
      // Ignore malformed lines.
    }
  });
  return () => {
    rl.close();
  };
}

function emit(out: NodeJS.WritableStream, event: ServeEvent): void {
  out.write(`${JSON.stringify(event)}\n`);
}

// ── Core logic ────────────────────────────────────────────────────────────────

interface Prepared {
  source: Source;
  fix: PhaseSetup;
  plan: PhaseSetup;
  compact: PhaseSetup;
  runId: string;
  runDir: string;
  started: number;
}

async function serveWithSource(
  opts: ServeCommandOptions,
  deps: ServeDeps,
  p: Prepared,
): Promise<void> {
  const { source, fix, plan, compact, runId, runDir, started } = p;
  const { stdin, stdout } = deps;

  const config =
    opts.github !== undefined && opts.config === undefined
      ? IasoConfigSchema.parse({})
      : loadConfig(source.repoPath, opts.config);
  deps.log(`source: ${source.label}${source.commit ? ` @ ${source.commit.slice(0, 12)}` : ""}`);

  let issue = source.issue;
  if (opts.github !== undefined) {
    const conventions = await readConventions(source.repoPath);
    deps.log(`conventions: ${describeConventions(conventions)}`);
    const { notes, ...saved } = conventions;
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "conventions.json"), JSON.stringify(saved, null, 2));
    if (conventions.aiPolicy.verdict === "banned") {
      throw new AiPolicyError(aiBanMessage(conventions), conventions);
    }
    if (notes !== "") issue = `${source.issue}\n\n${notes}`;
  }

  deps.log(`run ${runId}: starting sandbox`);
  const sandbox = deps.createSandbox({
    runId,
    repoPath: source.repoPath,
    ...(config.image === undefined ? {} : { image: config.image }),
  });
  await sandbox.start();
  try {
    const limits = {
      maxSteps: opts.maxSteps,
      maxCostUsd: opts.maxCost,
      maxTimeMinutes: opts.maxTime,
    };

    const session = createSession({
      fix,
      plan,
      compact,
      sandbox,
      issue,
      limits,
      runDir,
      extraRules: config.extraRules,
      usePlan: opts.plan,
      approvalPolicy: { default: "ask", rules: [] },
    });

    const stopControls = startControlReader(stdin, session);
    emit(stdout, { type: "run.created", run_id: runId, status: "created" });

    const seenFirstStep = { value: false };
    let pipelineResult: PipelineResult | undefined;

    const startPromise = session.start();
    for await (const event of session.events) {
      const serveEvent = translateEvent(runId, event, seenFirstStep);
      if (serveEvent) emit(stdout, serveEvent);
      if (event.kind === "finished") pipelineResult = event.result;
    }
    await startPromise;
    stopControls();

    if (pipelineResult) {
      await writeReport(runDir, {
        runId,
        issue: source.issue,
        source: {
          label: source.label,
          ...(source.issueUrl === undefined ? {} : { issueUrl: source.issueUrl }),
          ...(source.commit === undefined ? {} : { commit: source.commit }),
        },
        model: opts.model,
        ...(opts.planModel === undefined ? {} : { planModel: opts.planModel }),
        elapsedMs: Date.now() - started,
        result: pipelineResult,
      });
      deps.log(
        `${pipelineResult.status}: ${String(pipelineResult.steps)} steps, $${pipelineResult.costUsd.toFixed(4)}. Report: ${join(runDir, "report.md")}`,
      );
    }
  } finally {
    await sandbox.destroy();
  }
}

export async function executeServeCommand(
  opts: ServeCommandOptions,
  deps: ServeDeps,
): Promise<void> {
  if (!opts.stdio) throw new Error("Only --stdio transport is supported.");

  const choice = chooseSource(opts);
  const catalogue = loadCatalogue();
  const fixDeps: CommandDeps = {
    checkClaim: deps.checkClaim,
    resolveSource: deps.resolveSource,
    createProvider: deps.createProvider,
    createSandbox: deps.createSandbox,
    review: () => Promise.resolve({ kind: "approve" as const }),
    log: deps.log,
  };
  const fix = setupFor(opts.model, fixDeps);
  const plan = opts.planModel === undefined ? fix : setupFor(opts.planModel, fixDeps);
  const compactId = opts.compactModel ?? defaultCompactModel(catalogue, opts.model);
  const compact = compactId === opts.model ? fix : setupFor(compactId, fixDeps);
  const runId = newRunId();
  const runDir = join(resolve(opts.runs), runId);
  const started = Date.now();

  if (choice.kind === "github") {
    const claim = await deps.checkClaim(choice.url);
    for (const line of describeClaim(claim)) deps.log(line);
    if (claim.blockers.length > 0) {
      throw new IssueClaimedError(
        claimMessage(claim, "no clone, sandbox or model call was started"),
        claim,
      );
    }
  }

  deps.log(`run ${runId}: getting the source`);
  const source = await deps.resolveSource(choice);
  try {
    await serveWithSource(opts, deps, { source, fix, plan, compact, runId, runDir, started });
  } finally {
    await source.cleanup();
  }
}

// ── Commander registration ────────────────────────────────────────────────────

function positive(name: string): (value: string) => number {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
      throw new InvalidArgumentError(`${name} must be a number above 0.`);
    return n;
  };
}

export function registerServe(program: Command, deps: () => ServeDeps = defaultServeDeps): void {
  program
    .command("serve")
    .description("Run a session and stream events over stdio (JSON-lines)")
    .requiredOption(
      "--stdio",
      "use stdin/stdout transport (required; reserved for future transports)",
    )
    .option("--repo <path>", "repository to fix; needs --issue")
    .option("--issue <file>", "file with the bug report; needs --repo")
    .option("--github <url>", "GitHub issue URL")
    .option("--model <id>", "model for reproduce, fix, verify", DEFAULT_MODEL)
    .option("--plan-model <id>", "model for the plan phase (default: --model)")
    .option(
      "--compact-model <id>",
      "model that summarises old steps (default: cheapest of provider)",
    )
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
    .option("--config <file>", "path to .iaso.json")
    .option("--no-plan", "skip the plan phase")
    .action(async (opts: ServeCommandOptions) => {
      await executeServeCommand(opts, deps());
    });
}
