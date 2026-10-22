import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BenchError, readPredictions, readTasks, runBench } from "../src/bench/runner.js";
import type { BenchDeps, BenchOptions } from "../src/bench/runner.js";
import {
  type BenchCommandDeps,
  type BenchCommandOptions,
  defaultBenchDir,
  executeBench,
} from "../src/commands/bench.js";
import { findModel, loadCatalogue } from "../src/models.js";
import { MockProvider, mockToolCall } from "../src/providers/mock.js";
import { instanceImage } from "../src/sandbox/prebuilt.js";
import type { Sandbox } from "../src/sandbox/types.js";
import { type SweInstance, renderSweIssue, sampleInstances } from "../src/sources/swebench.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const MODEL = "anthropic:claude-haiku-5-5";
const SHA = "d16bfe05a744909de4b27f5875fe0d4ed41ce607";
const instance = (n: number): SweInstance => ({
  instanceId: `owner__repo-${String(n).padStart(3, "0")}`,
  repo: "owner/repo",
  baseCommit: SHA,
  problemStatement: `Problem ${String(n)}`,
});
const instances = (n: number): SweInstance[] => Array.from({ length: n }, (_, i) => instance(i));

const submit = (id: string) =>
  mockToolCall(id, "submit", { summary: "fixed", testsAdded: [], confidence: "high" });
const submits = (n: number) => Array.from({ length: n }, (_, i) => submit(`s${String(i)}`));

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "iaso-bench-"));

/** A fake sandbox that records what happened to it, in order. */
function tracked(events: string[], id: string, over: Partial<Sandbox> = {}): Sandbox {
  const { sandbox } = fakeSandbox();
  return {
    ...sandbox,
    start: () => {
      events.push(`start ${id}`);
      return Promise.resolve();
    },
    setNetwork: (enabled) => {
      events.push(`network ${String(enabled)} ${id}`);
      return Promise.resolve();
    },
    destroy: () => {
      events.push(`destroy ${id}`);
      return Promise.resolve();
    },
    ...over,
  };
}

async function setup(
  over: {
    script?: ReturnType<typeof submit>[];
    options?: Partial<BenchOptions>;
    deps?: Partial<BenchDeps>;
    count?: number;
    sandboxFor?: (inst: SweInstance, events: string[]) => Sandbox;
  } = {},
) {
  const count = over.count ?? 3;
  const events: string[] = [];
  const logs: string[] = [];
  const provider = new MockProvider(over.script ?? submits(count), MODEL);
  const removed: string[] = [];
  const runIds: string[] = [];
  const options: BenchOptions = {
    instances: instances(count),
    modelName: MODEL,
    benchDir: await tmp(),
    limits: { maxSteps: 10, maxCostUsd: 1, maxTimeMinutes: 5 },
    concurrency: 1,
    usePlan: false,
    resume: false,
    keepImages: false,
    ...over.options,
  };
  const deps: BenchDeps = {
    createSandbox: (inst, runId) => {
      runIds.push(runId);
      return over.sandboxFor ? over.sandboxFor(inst, events) : tracked(events, inst.instanceId);
    },
    fix: { provider, prices: findModel(loadCatalogue(), MODEL) },
    removeImage: (image) => {
      removed.push(image);
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
    ...over.deps,
  };
  return { options, deps, events, logs, removed, runIds, provider };
}

describe("runBench", () => {
  it("runs every instance and writes a prediction and a task record for each", async () => {
    const s = await setup();
    const summary = await runBench(s.options, s.deps);
    expect(summary).toMatchObject({ total: 3, ran: 3, skipped: 0, submitted: 3 });

    const predictions = await readPredictions(s.options.benchDir);
    expect(predictions.map((p) => p.instance_id)).toEqual(instances(3).map((i) => i.instanceId));
    expect(predictions[0]).toEqual({
      instance_id: "owner__repo-000",
      model_name_or_path: MODEL,
      model_patch: "DIFF",
    });
    const tasks = await readTasks(s.options.benchDir);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      status: "submitted",
      runDir: join("runs", "owner__repo-000"),
    });
  });

  it("cuts the network before the agent starts, so the fix cannot be looked up", async () => {
    const s = await setup({ count: 1 });
    await runBench(s.options, s.deps);
    expect(s.events.slice(0, 2)).toEqual([
      "start owner__repo-000",
      "network false owner__repo-000",
    ]);
    // The first model call happens after that: the agent has had no network from its first step.
    expect(s.provider.requests).toHaveLength(1);
  });

  it("gives the agent the problem statement and nothing else", async () => {
    const s = await setup({ count: 1 });
    await runBench(s.options, s.deps);
    const sent = JSON.stringify(s.provider.requests[0]?.messages);
    expect(sent).toContain(renderSweIssue(instance(0)).split("\n")[0]);
    expect(sent).toContain("Problem 0");
  });

  it("gives every sandbox its own name, and destroys and removes the image of each", async () => {
    const s = await setup();
    await runBench(s.options, s.deps);
    expect(new Set(s.runIds).size).toBe(3);
    expect(s.runIds.every((id) => /^bench-owner__repo-\d{3}-[0-9a-z]+$/.test(id))).toBe(true);
    expect(s.events.filter((e) => e.startsWith("destroy"))).toHaveLength(3);
    expect(s.removed).toEqual(instances(3).map((i) => instanceImage(i.instanceId)));
  });

  it("keeps the images with keepImages, and ignores a failed removal", async () => {
    const kept = await setup({ options: { keepImages: true } });
    await runBench(kept.options, kept.deps);
    expect(kept.removed).toEqual([]);

    const failing = await setup({
      count: 1,
      deps: { removeImage: () => Promise.reject(new Error("image in use")) },
    });
    await expect(runBench(failing.options, failing.deps)).resolves.toMatchObject({ ran: 1 });
  });

  it("records a failed instance with an empty patch and a reason, and carries on", async () => {
    const s = await setup({
      sandboxFor: (inst, events) =>
        inst.instanceId === "owner__repo-001"
          ? tracked(events, inst.instanceId, {
              start: () => Promise.reject(new Error("pull access denied")),
            })
          : tracked(events, inst.instanceId),
      script: submits(2),
    });
    const summary = await runBench(s.options, s.deps);
    expect(summary).toMatchObject({ ran: 3, submitted: 2 });

    const failed = (await readTasks(s.options.benchDir)).find((t) => t.status === "error");
    expect(failed).toMatchObject({ instanceId: "owner__repo-001", steps: 0, patchBytes: 0 });
    expect(failed?.message).toContain("pull access denied");
    const prediction = (await readPredictions(s.options.benchDir)).find(
      (p) => p.instance_id === "owner__repo-001",
    );
    expect(prediction?.model_patch).toBe("");
    // Its sandbox is still destroyed, and the later instance ran.
    expect(s.events).toContain("destroy owner__repo-001");
    expect(
      s.logs.some((l) => l.includes("owner__repo-001: error") && l.includes("pull access denied")),
    ).toBe(true);
  });

  it("keeps the patch of a run that ran out of budget before it submitted", async () => {
    const s = await setup({
      count: 1,
      options: { limits: { maxSteps: 1, maxCostUsd: 1, maxTimeMinutes: 5 } },
      script: [mockToolCall("b1", "bash", { cmd: "echo hi" }), submit("later")],
    });
    await runBench(s.options, s.deps);
    const [task] = await readTasks(s.options.benchDir);
    const [prediction] = await readPredictions(s.options.benchDir);
    expect(task?.status).toBe("budget_exceeded");
    expect(prediction?.model_patch).toBe("DIFF");
  });

  it("refuses a folder that already has results unless asked to resume", async () => {
    const s = await setup({ count: 2, script: submits(2) });
    await runBench(s.options, s.deps);
    const again = await setup({ count: 2, options: { benchDir: s.options.benchDir } });
    await expect(runBench(again.options, again.deps)).rejects.toThrow(BenchError);
    await expect(runBench(again.options, again.deps)).rejects.toThrow(/--resume/);
  });

  it("resumes: skips finished instances and runs only the rest", async () => {
    const first = await setup({ count: 3, script: submits(3) });
    // Pretend the first run was killed after one task: keep only that task's record.
    await runBench({ ...first.options, instances: instances(1) }, first.deps);

    const resumed = await setup({
      count: 3,
      script: submits(2),
      options: { benchDir: first.options.benchDir, resume: true },
    });
    const summary = await runBench(resumed.options, resumed.deps);
    expect(summary).toMatchObject({ total: 3, ran: 2, skipped: 1, submitted: 3 });
    expect(resumed.runIds).toHaveLength(2);
    expect(resumed.logs[0]).toContain("resuming: 1 already done");
    expect((await readTasks(first.options.benchDir)).map((t) => t.instanceId)).toEqual(
      instances(3).map((i) => i.instanceId),
    );
  });

  it("treats a half-written last line as unfinished, and counts a prediction only once", async () => {
    const s = await setup({ count: 2, script: submits(2) });
    await runBench(s.options, s.deps);
    // A crash cut the last task record in half, and the prediction was written twice.
    const tasksPath = join(s.options.benchDir, "tasks.jsonl");
    const lines = (await readFile(tasksPath, "utf8")).trim().split("\n");
    await writeFile(tasksPath, `${lines[0] ?? ""}\n${(lines[1] ?? "").slice(0, 20)}`);
    await appendFile(
      join(s.options.benchDir, "predictions.jsonl"),
      `${JSON.stringify({ instance_id: "owner__repo-001", model_name_or_path: MODEL, model_patch: "NEWER" })}\n`,
    );

    expect((await readTasks(s.options.benchDir)).map((t) => t.instanceId)).toEqual([
      "owner__repo-000",
    ]);
    const resumed = await setup({
      count: 2,
      script: submits(1),
      options: { benchDir: s.options.benchDir, resume: true },
    });
    expect(await runBench(resumed.options, resumed.deps)).toMatchObject({ ran: 1, skipped: 1 });
    const predictions = await readPredictions(s.options.benchDir);
    expect(predictions.filter((p) => p.instance_id === "owner__repo-001")).toHaveLength(1);
    expect(predictions.find((p) => p.instance_id === "owner__repo-001")?.model_patch).toBe("DIFF");
  });

  it("runs at most `concurrency` instances at once", async () => {
    let active = 0;
    let peak = 0;
    const s = await setup({
      count: 5,
      script: submits(5),
      options: { concurrency: 2 },
      sandboxFor: (inst, events) =>
        tracked(events, inst.instanceId, {
          start: async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 15));
          },
          destroy: () => {
            active -= 1;
            return Promise.resolve();
          },
        }),
    });
    const summary = await runBench(s.options, s.deps);
    expect(summary.ran).toBe(5);
    expect(peak).toBe(2);
    expect(await readTasks(s.options.benchDir)).toHaveLength(5);
  });
});

describe("executeBench", () => {
  const base: BenchCommandOptions = {
    dataset: "swebench-lite",
    sample: 3,
    seed: 42,
    concurrency: 1,
    model: MODEL,
    plan: false,
    maxSteps: 10,
    maxCost: 1,
    maxTime: 5,
  };

  async function commandSetup(over: Partial<BenchCommandOptions> = {}, memory?: number) {
    const all = instances(10);
    const logs: string[] = [];
    const provider = new MockProvider(submits(10), MODEL);
    const loadInstances = vi.fn(() => Promise.resolve(all));
    const createProvider = vi.fn(() => provider);
    const sandboxed: string[] = [];
    const deps: BenchCommandDeps = {
      loadInstances,
      createProvider,
      createSandbox: (inst) => {
        sandboxed.push(inst.instanceId);
        return tracked([], inst.instanceId);
      },
      removeImage: () => Promise.resolve(),
      dockerMemoryBytes: () => Promise.resolve(memory),
      log: (line) => logs.push(line),
    };
    const out = await tmp();
    return {
      deps,
      logs,
      loadInstances,
      createProvider,
      sandboxed,
      out,
      opts: { ...base, out, ...over },
    };
  }

  it("will not start without --sample, and touches neither the dataset nor a model", async () => {
    const s = await commandSetup();
    const opts: BenchCommandOptions = { ...s.opts };
    delete opts.sample;
    await expect(executeBench(opts, s.deps)).rejects.toThrow(/Give --sample <n>/);
    expect(s.loadInstances).not.toHaveBeenCalled();
    expect(s.createProvider).not.toHaveBeenCalled();
  });

  it("rejects an unknown dataset", async () => {
    const s = await commandSetup({ dataset: "swebench-full" });
    await expect(executeBench(s.opts, s.deps)).rejects.toThrow(/Unknown dataset.*swebench-lite/);
  });

  it("runs the seeded sample, the same one every time", async () => {
    const a = await commandSetup();
    await executeBench(a.opts, a.deps);
    const expected = sampleInstances(instances(10), 3, 42).map((i) => i.instanceId);
    expect(a.sandboxed).toEqual(expected);

    const b = await commandSetup();
    await executeBench(b.opts, b.deps);
    expect(b.sandboxed).toEqual(expected);
    expect((await readPredictions(a.out)).map((p) => p.instance_id)).toEqual(expected);
  });

  it("reports the totals and where the predictions are", async () => {
    const s = await commandSetup();
    const summary = await executeBench(s.opts, s.deps);
    expect(summary).toMatchObject({ ran: 3, submitted: 3 });
    const last = s.logs.at(-1) ?? "";
    expect(last).toContain("3 of 3 submitted");
    expect(last).toContain(join(s.out, "predictions.jsonl"));
  });

  it("warns when the sandboxes could use more memory than Docker has", async () => {
    const tight = await commandSetup({ concurrency: 4 }, 7.6 * 1024 ** 3);
    await executeBench(tight.opts, tight.deps);
    expect(tight.logs.some((l) => l.startsWith("warning: 4 sandboxes can use up to 16 GB"))).toBe(
      true,
    );

    const roomy = await commandSetup({ concurrency: 1 }, 7.6 * 1024 ** 3);
    await executeBench(roomy.opts, roomy.deps);
    expect(roomy.logs.some((l) => l.startsWith("warning"))).toBe(false);

    const unknown = await commandSetup({ concurrency: 4 }, undefined);
    await executeBench(unknown.opts, unknown.deps);
    expect(unknown.logs.some((l) => l.startsWith("warning"))).toBe(false);
  });

  it("names the default folder from the options, so the same command finds it to resume", () => {
    expect(defaultBenchDir({ dataset: "swebench-lite", model: MODEL, seed: 42, sample: 10 })).toBe(
      join("runs", "bench-swebench-lite-anthropic-claude-haiku-5-5-seed42-n10"),
    );
  });
});
