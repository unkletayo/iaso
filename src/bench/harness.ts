import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { readPredictions } from "./runner.js";

/** The harness version Iaso was checked against. */
export const SWEBENCH_VERSION = "5.0.2";
/** The dataset name the harness itself uses for SWE-bench Lite. */
export const HARNESS_DATASET = "SWE-bench/SWE-bench_Lite";
/** The harness gives each instance this long to run its tests. */
const DEFAULT_TIMEOUT_SEC = 1800;
/** How much of a failed command's output is kept for the error message. */
const TAIL_CHARS = 2000;

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export interface CommandResult {
  exitCode: number;
  /** The end of the output, for error messages. The whole output goes to `logFile`. */
  tail: string;
}

/** Runs a program on the host. Injected, so tests need neither Python nor Docker. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  opts: { cwd?: string; logFile?: string },
) => Promise<CommandResult>;

/** The real runner. A program that cannot start is exit code 127, not a thrown error. */
export const spawnRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : undefined;
    let tail = "";
    const child = spawn(command, [...args], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: process.env,
    });
    const take = (chunk: Buffer): void => {
      log?.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_CHARS);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      log?.end();
      resolve({ exitCode: 127, tail: err.message });
    });
    child.on("close", (code) => {
      log?.end();
      resolve({ exitCode: code ?? 1, tail });
    });
  });

export const defaultVenvDir = (): string => join(homedir(), ".iaso", "swebench-venv");

/**
 * The Python of a venv with the official harness installed. The venv is made on first use, so
 * nothing is installed on the host's own Python.
 */
export async function ensureHarnessVenv(
  run: CommandRunner,
  o: { venvDir?: string; python?: string; log?: (line: string) => void } = {},
): Promise<string> {
  const venv = o.venvDir ?? defaultVenvDir();
  const py = join(venv, "bin", "python");
  if ((await run(py, ["-c", "import swebench"], {})).exitCode === 0) return py;

  o.log?.(`setting up the SWE-bench harness in ${venv} (first use only)`);
  await mkdir(join(venv, ".."), { recursive: true });
  const made = await run(o.python ?? "python3", ["-m", "venv", venv], {});
  if (made.exitCode !== 0) {
    throw new HarnessError(
      `Could not create a Python venv at ${venv} (exit ${String(made.exitCode)}). ` +
        `Python 3.10 or newer is needed.\n${made.tail}`,
    );
  }
  const installed = await run(
    py,
    ["-m", "pip", "install", "--disable-pip-version-check", `swebench==${SWEBENCH_VERSION}`],
    {},
  );
  if (installed.exitCode !== 0) {
    throw new HarnessError(
      `Could not install swebench ${SWEBENCH_VERSION} (exit ${String(installed.exitCode)}).\n${installed.tail}`,
    );
  }
  return py;
}

const ids = z.array(z.string()).default([]);

/** The harness's run report (`schema_version` 2). Only what Iaso reads. */
const reportSchema = z.object({
  submitted_ids: ids,
  completed_ids: ids,
  resolved_ids: ids,
  unresolved_ids: ids,
  error_ids: ids,
  empty_patch_ids: ids,
  incomplete_ids: ids,
  infra_failure_ids: ids,
});

export interface HarnessReport {
  runId: string;
  /** Folder of the harness's own logs and reports, relative to the bench folder. */
  dir: string;
  /** Where the per-instance logs are, relative to the bench folder: `<dir>/<id>/`. */
  instanceLogs: string;
  resolved: ReadonlySet<string>;
  unresolved: ReadonlySet<string>;
  error: ReadonlySet<string>;
  emptyPatch: ReadonlySet<string>;
  incomplete: ReadonlySet<string>;
  infraFailure: ReadonlySet<string>;
}

export type Outcome =
  | "resolved"
  | "unresolved"
  | "error"
  | "empty patch"
  | "infrastructure failure"
  | "incomplete"
  | "not graded";

/** What happened to one instance. An empty patch is named as such, though it also fails. */
export function outcomeOf(id: string, report: HarnessReport | undefined): Outcome {
  if (report === undefined) return "not graded";
  if (report.resolved.has(id)) return "resolved";
  if (report.emptyPatch.has(id)) return "empty patch";
  if (report.infraFailure.has(id)) return "infrastructure failure";
  if (report.error.has(id)) return "error";
  if (report.unresolved.has(id)) return "unresolved";
  if (report.incomplete.has(id)) return "incomplete";
  return "not graded";
}

export interface HarnessOptions {
  benchDir: string;
  /** Only these instances are graded: the ones in this bench's sample. */
  instanceIds: readonly string[];
  modelName: string;
  maxWorkers: number;
  timeoutSec?: number;
  venvDir?: string;
  python?: string;
  log?: (line: string) => void;
}

const slug = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "-");

/**
 * Grade the bench's predictions with the official harness, which runs each patch plus the hidden
 * tests in the instance's own image. It writes its logs into `<benchDir>/harness`, and a rerun with
 * the same run id reuses the instances it already graded.
 */
export async function runHarness(
  o: HarnessOptions,
  run: CommandRunner = spawnRunner,
): Promise<HarnessReport> {
  const dir = join(o.benchDir, "harness");
  await mkdir(dir, { recursive: true });
  const py = await ensureHarnessVenv(run, {
    ...(o.venvDir === undefined ? {} : { venvDir: o.venvDir }),
    ...(o.python === undefined ? {} : { python: o.python }),
    ...(o.log === undefined ? {} : { log: o.log }),
  });

  // The harness reads every line, so give it one prediction per instance, for this sample only.
  const wanted = new Set(o.instanceIds);
  const predictions = (await readPredictions(o.benchDir)).filter((p) => wanted.has(p.instance_id));
  if (predictions.length === 0) throw new HarnessError("There are no predictions to grade.");
  const predictionsPath = join(dir, "predictions.jsonl");
  await writeFile(predictionsPath, predictions.map((p) => JSON.stringify(p)).join("\n") + "\n");

  const runId = `iaso-${slug(basename(o.benchDir))}`;
  o.log?.(
    `grading ${String(predictions.length)} predictions with the SWE-bench harness (run ${runId})`,
  );
  const res = await run(
    py,
    [
      "-m",
      "swebench.harness.run_evaluation",
      "-d",
      HARNESS_DATASET,
      "-p",
      predictionsPath,
      "-i",
      ...predictions.map((p) => p.instance_id),
      "--max_workers",
      String(o.maxWorkers),
      "-t",
      String(o.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
      "-id",
      runId,
      "--report_dir",
      ".",
    ],
    // The harness writes `logs/` relative to where it runs, so run it inside the bench folder.
    { cwd: dir, logFile: join(dir, "harness.log") },
  );
  if (res.exitCode !== 0) {
    throw new HarnessError(
      `The SWE-bench harness failed (exit ${String(res.exitCode)}). Full output: ${join(dir, "harness.log")}\n${res.tail}`,
    );
  }

  // The summary is named `<model>.<run id>.json`, with "/" in the model name turned into "__".
  const reportFile = join(dir, `${o.modelName.replaceAll("/", "__")}.${runId}.json`);
  let parsed: z.infer<typeof reportSchema>;
  try {
    parsed = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")));
  } catch (err) {
    throw new HarnessError(
      `The harness finished but its report ${reportFile} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return {
    runId,
    dir: "harness",
    instanceLogs: join(
      "harness",
      "logs",
      "run_evaluation",
      runId,
      o.modelName.replaceAll("/", "__"),
    ),
    resolved: new Set(parsed.resolved_ids),
    unresolved: new Set(parsed.unresolved_ids),
    error: new Set(parsed.error_ids),
    emptyPatch: new Set(parsed.empty_patch_ids),
    incomplete: new Set(parsed.incomplete_ids),
    infraFailure: new Set(parsed.infra_failure_ids),
  };
}
