import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type CommandResult,
  type CommandRunner,
  type HarnessReport,
  HarnessError,
  SWEBENCH_VERSION,
  ensureHarnessVenv,
  outcomeOf,
  runHarness,
} from "../src/bench/harness.js";
import { renderResults, wilsonInterval } from "../src/bench/results.js";
import type { TaskRecord } from "../src/bench/runner.js";

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "iaso-harness-"));
const ok: CommandResult = { exitCode: 0, tail: "" };

interface Call {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
}

/** A fake runner: `handle` answers each call, and every call is recorded. */
function fakeRunner(handle: (c: Call) => CommandResult | Promise<CommandResult> = () => ok) {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, opts) => {
    const call = { command, args, cwd: opts.cwd };
    calls.push(call);
    return handle(call);
  };
  return { run, calls };
}

describe("ensureHarnessVenv", () => {
  it("uses the venv as it is when the harness can already be imported", async () => {
    const f = fakeRunner();
    const py = await ensureHarnessVenv(f.run, { venvDir: "/v" });
    expect(py).toBe("/v/bin/python");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ command: "/v/bin/python", args: ["-c", "import swebench"] });
  });

  it("creates the venv and installs the pinned harness on first use", async () => {
    const dir = await tmp();
    const venv = join(dir, "venv");
    const logs: string[] = [];
    const f = fakeRunner((c) =>
      c.args[0] === "-c" ? { exitCode: 1, tail: "No module named swebench" } : ok,
    );
    const py = await ensureHarnessVenv(f.run, {
      venvDir: venv,
      python: "python3.12",
      log: (l) => logs.push(l),
    });
    expect(py).toBe(join(venv, "bin", "python"));
    expect(f.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual([
      `${py} -c import swebench`,
      `python3.12 -m venv ${venv}`,
      `${py} -m pip install --disable-pip-version-check swebench==${SWEBENCH_VERSION}`,
    ]);
    expect(logs[0]).toContain("first use only");
  });

  it("says which Python is needed when the venv cannot be made", async () => {
    const f = fakeRunner((c) =>
      c.args[0] === "-c"
        ? { exitCode: 1, tail: "" }
        : c.args[0] === "-m" && c.args[1] === "venv"
          ? { exitCode: 1, tail: "ensurepip is not available" }
          : ok,
    );
    const err = await ensureHarnessVenv(f.run, { venvDir: join(await tmp(), "v") }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as Error).message).toContain("Python 3.10 or newer");
    expect((err as Error).message).toContain("ensurepip is not available");
  });

  it("shows pip's output when the install fails", async () => {
    const f = fakeRunner((c) =>
      c.args[0] === "-c"
        ? { exitCode: 1, tail: "" }
        : c.args.includes("pip")
          ? { exitCode: 1, tail: "ERROR: no matching distribution" }
          : ok,
    );
    await expect(ensureHarnessVenv(f.run, { venvDir: join(await tmp(), "v") })).rejects.toThrow(
      /Could not install swebench.*no matching distribution/s,
    );
  });
});

describe("runHarness", () => {
  const MODEL = "anthropic/claude-haiku-5-5";
  const prediction = (id: string, patch: string) =>
    JSON.stringify({ instance_id: id, model_name_or_path: MODEL, model_patch: patch });

  async function benchDir(lines: string[]): Promise<string> {
    const root = await tmp();
    const dir = join(root, "bench run:1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "predictions.jsonl"), `${lines.join("\n")}\n`);
    return dir;
  }

  /** The runner of a healthy machine: the venv is ready, and the harness writes its report. */
  function healthy(report: object, over: { harnessExit?: number } = {}) {
    return fakeRunner(async (c) => {
      if (c.args[0] === "-m" && c.args[1] === "swebench.harness.run_evaluation") {
        if (over.harnessExit) return { exitCode: over.harnessExit, tail: "docker: not running" };
        const id = c.args[c.args.indexOf("-id") + 1];
        await writeFile(
          join(c.cwd ?? "", `${MODEL.replaceAll("/", "__")}.${id ?? ""}.json`),
          JSON.stringify(report),
        );
      }
      return ok;
    });
  }

  it("runs the harness inside the bench folder, for this sample only", async () => {
    const dir = await benchDir([
      prediction("a__a-1", "OLD"),
      prediction("b__b-2", "P2"),
      prediction("z__z-9", "NOT IN THIS SAMPLE"),
      prediction("a__a-1", "NEW"),
    ]);
    const f = healthy({ resolved_ids: ["a__a-1"], unresolved_ids: ["b__b-2"] });
    const report = await runHarness(
      {
        benchDir: dir,
        instanceIds: ["a__a-1", "b__b-2"],
        modelName: MODEL,
        maxWorkers: 2,
        venvDir: "/v",
      },
      f.run,
    );

    const call = f.calls.find((c) => c.args[1] === "swebench.harness.run_evaluation");
    expect(call?.command).toBe("/v/bin/python");
    expect(call?.cwd).toBe(join(dir, "harness"));
    const args = call?.args ?? [];
    expect(args.slice(args.indexOf("-i"), args.indexOf("--max_workers"))).toEqual([
      "-i",
      "a__a-1",
      "b__b-2",
    ]);
    expect(args[args.indexOf("-d") + 1]).toBe("SWE-bench/SWE-bench_Lite");
    expect(args[args.indexOf("--max_workers") + 1]).toBe("2");
    expect(args[args.indexOf("-t") + 1]).toBe("1800");
    expect(args[args.indexOf("-id") + 1]).toBe("iaso-bench-run-1");

    // The file the harness reads has one line per instance, the newest, for this sample only.
    const sent = (await readFile(join(dir, "harness", "predictions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { instance_id: string; model_patch: string });
    expect(sent.map((p) => [p.instance_id, p.model_patch])).toEqual([
      ["a__a-1", "NEW"],
      ["b__b-2", "P2"],
    ]);

    expect(report.runId).toBe("iaso-bench-run-1");
    expect([...report.resolved]).toEqual(["a__a-1"]);
    expect([...report.unresolved]).toEqual(["b__b-2"]);
    expect(report.instanceLogs).toBe(
      join("harness", "logs", "run_evaluation", "iaso-bench-run-1", "anthropic__claude-haiku-5-5"),
    );
  });

  it("reads every category of the report, and treats a missing one as empty", async () => {
    const dir = await benchDir([prediction("a__a-1", "x")]);
    const f = healthy({
      resolved_ids: [],
      error_ids: ["e"],
      empty_patch_ids: ["p"],
      incomplete_ids: ["i"],
      infra_failure_ids: ["f"],
    });
    const r = await runHarness(
      { benchDir: dir, instanceIds: ["a__a-1"], modelName: MODEL, maxWorkers: 1, venvDir: "/v" },
      f.run,
    );
    expect([...r.error, ...r.emptyPatch, ...r.incomplete, ...r.infraFailure]).toEqual([
      "e",
      "p",
      "i",
      "f",
    ]);
    expect(r.unresolved.size).toBe(0);
  });

  it("fails with the log location and the end of the output when the harness exits badly", async () => {
    const dir = await benchDir([prediction("a__a-1", "x")]);
    const f = healthy({}, { harnessExit: 2 });
    const err = await runHarness(
      { benchDir: dir, instanceIds: ["a__a-1"], modelName: MODEL, maxWorkers: 1, venvDir: "/v" },
      f.run,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as Error).message).toContain("exit 2");
    expect((err as Error).message).toContain(join(dir, "harness", "harness.log"));
    expect((err as Error).message).toContain("docker: not running");
  });

  it("fails clearly when the harness finished but wrote no usable report", async () => {
    const dir = await benchDir([prediction("a__a-1", "x")]);
    const f = fakeRunner(); // exits 0 and writes nothing
    await expect(
      runHarness(
        { benchDir: dir, instanceIds: ["a__a-1"], modelName: MODEL, maxWorkers: 1, venvDir: "/v" },
        f.run,
      ),
    ).rejects.toThrow(/finished but its report .* could not be read/);
  });

  it("does not start the harness when there is nothing to grade", async () => {
    const dir = await benchDir([prediction("z__z-9", "x")]);
    const f = healthy({});
    await expect(
      runHarness(
        { benchDir: dir, instanceIds: ["a__a-1"], modelName: MODEL, maxWorkers: 1, venvDir: "/v" },
        f.run,
      ),
    ).rejects.toThrow(/no predictions to grade/);
    expect(f.calls.some((c) => c.args[1] === "swebench.harness.run_evaluation")).toBe(false);
  });

  it("ignores a half-written last line of predictions", async () => {
    const dir = await benchDir([prediction("a__a-1", "x")]);
    await appendFile(join(dir, "predictions.jsonl"), '{"instance_id": "b__b-2", "model_na');
    const f = healthy({ resolved_ids: ["a__a-1"] });
    await runHarness(
      {
        benchDir: dir,
        instanceIds: ["a__a-1", "b__b-2"],
        modelName: MODEL,
        maxWorkers: 1,
        venvDir: "/v",
      },
      f.run,
    );
    const call = f.calls.find((c) => c.args[1] === "swebench.harness.run_evaluation");
    expect(call?.args.slice(call.args.indexOf("-i"), call.args.indexOf("--max_workers"))).toEqual([
      "-i",
      "a__a-1",
    ]);
  });
});

const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);
const report = (over: Partial<HarnessReport> = {}): HarnessReport => ({
  runId: "iaso-x",
  dir: "harness",
  instanceLogs: join("harness", "logs", "run_evaluation", "iaso-x", "m"),
  resolved: set(),
  unresolved: set(),
  error: set(),
  emptyPatch: set(),
  incomplete: set(),
  infraFailure: set(),
  ...over,
});

describe("outcomeOf", () => {
  it("is not graded without a report, or for an instance the report does not mention", () => {
    expect(outcomeOf("a", undefined)).toBe("not graded");
    expect(outcomeOf("a", report())).toBe("not graded");
  });

  it("names an empty patch as such, though it also counts as unresolved", () => {
    const r = report({ emptyPatch: set("a"), unresolved: set("a") });
    expect(outcomeOf("a", r)).toBe("empty patch");
  });

  it("puts resolved first, then infrastructure, error, unresolved, incomplete", () => {
    const r = report({
      resolved: set("a"),
      unresolved: set("a", "b", "c", "d"),
      error: set("c", "d"),
      infraFailure: set("d"),
      incomplete: set("e"),
    });
    expect(["a", "b", "c", "d", "e"].map((id) => outcomeOf(id, r))).toEqual([
      "resolved",
      "unresolved",
      "error",
      "infrastructure failure",
      "incomplete",
    ]);
  });
});

describe("wilsonInterval", () => {
  const round = (x: number): number => Math.round(x * 1000) / 1000;

  it("matches known values for ten tasks", () => {
    const at = (k: number) => {
      const { low, high } = wilsonInterval(k, 10);
      return [round(low), round(high)];
    };
    expect(at(5)).toEqual([0.237, 0.763]);
    expect(at(7)).toEqual([0.397, 0.892]);
    expect(at(0)).toEqual([0, 0.278]);
    expect(at(10)).toEqual([0.722, 1]);
  });

  it("stays inside 0 and 1, and narrows as the sample grows", () => {
    for (const [k, n] of [
      [0, 1],
      [1, 1],
      [3, 50],
      [50, 50],
    ] as const) {
      const { low, high } = wilsonInterval(k, n);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
    }
    const small = wilsonInterval(7, 10);
    const large = wilsonInterval(70, 100);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it("knows nothing about zero tries", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("renderResults", () => {
  const task = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
    instanceId: id,
    status: "submitted",
    steps: 10,
    costUsd: 0.5,
    durationMs: 120_000,
    runDir: join("runs", id),
    patchBytes: 100,
    ...over,
  });
  const base = { dataset: "swebench-lite", modelName: "m", seed: 42 };

  it("reports the pass rate and cost, steps and time statistics", () => {
    const tasks = [
      task("a", { costUsd: 0.1, steps: 5 }),
      task("b", { costUsd: 0.3, steps: 15 }),
      task("c", { costUsd: 0.9, steps: 10 }),
      task("d", { costUsd: 0.5, steps: 30 }),
    ];
    const md = renderResults({
      ...base,
      tasks,
      report: report({ resolved: set("a", "b", "c"), unresolved: set("d") }),
      date: new Date("2026-10-22T10:00:00Z"),
    });
    expect(md).toContain("# Benchmark results: swebench-lite");
    expect(md).toContain("- date: 2026-10-22");
    expect(md).toContain("**resolved: 3 of 4 (75%, 95% CI 30%–95%)**");
    // mean 0.45, median (0.3 + 0.5) / 2 = 0.40, max 0.90, total 1.80
    expect(md).toContain("| $0.45 | $0.40 | $0.90 | $1.80 |");
    // steps: mean 15, median 12.5, max 30
    expect(md).toContain("| steps | 15.0 | 12.5 | 30 |");
    expect(md).toContain("| time | 2.0 min | 2.0 min | 2.0 min |");
    expect(md).toContain("| resolved | 3 |");
    expect(md).toContain("| unresolved | 1 |");
  });

  it("lists failures with links to the run folder and the harness log", () => {
    const md = renderResults({
      ...base,
      tasks: [task("a"), task("b", { status: "budget_exceeded", message: "time limit | reached" })],
      report: report({ resolved: set("a"), unresolved: set("b") }),
    });
    const row = md.split("\n").find((l) => l.startsWith("| b |")) ?? "";
    expect(row).toContain("| unresolved |");
    expect(row).toContain("budget_exceeded: time limit \\| reached");
    expect(row).toContain("[run folder](runs/b/)");
    expect(row).toContain("[log](harness/logs/run_evaluation/iaso-x/m/b/test_output.txt)");
    expect(md.split("\n").some((l) => l.startsWith("| a |"))).toBe(false);
  });

  it("says None when everything was resolved", () => {
    const md = renderResults({
      ...base,
      tasks: [task("a")],
      report: report({ resolved: set("a") }),
    });
    expect(md).toContain("## Failures\n\nNone.");
  });

  it("says not graded, without a pass rate, when there is no report", () => {
    const md = renderResults({ ...base, tasks: [task("a"), task("b")], report: undefined });
    expect(md).toContain("**not graded**");
    expect(md).not.toContain("resolved:");
    expect(md).toContain("| not graded | 2 |");
    const row = md.split("\n").find((l) => l.startsWith("| a |")) ?? "";
    expect(row.trimEnd().endsWith("|  |")).toBe(true); // no harness log to link
  });

  it("names tasks the report did not cover", () => {
    const md = renderResults({
      ...base,
      tasks: [task("a"), task("b")],
      report: report({ resolved: set("a") }),
    });
    expect(md).toContain("- 1 of 2 tasks have no grade");
  });

  it("marks a run that stopped early as partial, and says nothing when every task ran", () => {
    const one = [task("a")];
    const partial = renderResults({ ...base, tasks: one, sampled: 4, report: undefined });
    expect(partial).toContain("**partial run**: 1 of the 4 sampled tasks were run");
    const full = renderResults({ ...base, tasks: one, sampled: 1, report: undefined });
    expect(full).not.toContain("partial run");
    expect(renderResults({ ...base, tasks: one, report: undefined })).not.toContain("partial run");
  });

  it("copes with no tasks", () => {
    const md = renderResults({ ...base, tasks: [], report: report() });
    expect(md).toContain("**resolved: 0 of 0 (0%)**");
    expect(md).toContain("| $0.00 | $0.00 | $0.00 | $0.00 |");
  });
});
