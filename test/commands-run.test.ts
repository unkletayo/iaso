import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli.js";
import {
  type CommandDeps,
  type RunCommandOptions,
  executeCommand,
  newRunId,
  parseReview,
  registerRun,
} from "../src/commands/run.js";
import { Command } from "commander";
import { MockProvider, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const plan = {
  rootCauseHypothesis: "off by one",
  filesToChange: [{ path: "a.js", change: "x" }],
  testPlan: "t",
  risks: [],
  steps: ["s"],
};
const submit = mockToolCall("s", "submit", { summary: "done", testsAdded: [], confidence: "high" });

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "iaso-cmd-"));
  await mkdir(join(dir, "repo"));
  await writeFile(join(dir, "issue.md"), "the bug");
  const opts: RunCommandOptions = {
    repo: join(dir, "repo"),
    issue: join(dir, "issue.md"),
    model: "anthropic:claude-haiku-5-5",
    plan: true,
    maxSteps: 50,
    maxCost: 1,
    maxTime: 20,
    runs: join(dir, "runs"),
  };
  return { dir, opts };
}

function deps(provider: MockProvider): { deps: CommandDeps; lines: string[] } {
  const lines: string[] = [];
  const fake = fakeSandbox();
  return {
    lines,
    deps: {
      createProvider: () => provider,
      createSandbox: () => fake.sandbox,
      review: vi.fn(() => Promise.resolve({ kind: "approve" as const })),
      log: (l) => lines.push(l),
    },
  };
}

describe("parseReview", () => {
  it("maps y, n and feedback", () => {
    expect(parseReview("y", true)).toEqual({ kind: "approve" });
    expect(parseReview(" YES ", true)).toEqual({ kind: "approve" });
    expect(parseReview("n", true)).toEqual({ kind: "reject" });
    expect(parseReview("also check negatives", true)).toEqual({
      kind: "feedback",
      text: "also check negatives",
    });
  });

  it("asks again on empty input, and on feedback when no revision is possible", () => {
    expect(parseReview("", true)).toBeNull();
    expect(parseReview("more", false)).toBeNull();
  });
});

describe("newRunId", () => {
  it("is a valid container-name suffix and sorts by time", () => {
    const id = newRunId(new Date("2026-10-16T17:05:09Z"));
    expect(id).toMatch(/^20261016T170509-[0-9a-f]{4}$/);
  });
});

describe("executeCommand", () => {
  it("run: plans, fixes, and writes report.md and patch.diff", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("p", "submit_plan", plan), submit]));
    await executeCommand("run", w.opts, d.deps);
    const [runId] = await readdir(w.opts.runs);
    const report = await readFile(join(w.opts.runs, runId ?? "", "report.md"), "utf8");
    expect(report).toContain("status: submitted");
    expect(report).toContain("off by one");
    expect(d.lines.at(-1)).toMatch(/^submitted: 2 steps/);
    expect(d.deps.review).not.toHaveBeenCalled();
  });

  it("run --approve-plan asks the reviewer", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("p", "submit_plan", plan), submit]));
    await executeCommand("run", { ...w.opts, approvePlan: true }, d.deps);
    expect(d.deps.review).toHaveBeenCalledOnce();
  });

  it("run --no-plan skips planning", async () => {
    const w = await workspace();
    const provider = new MockProvider([submit]);
    await executeCommand("run", { ...w.opts, plan: false }, deps(provider).deps);
    expect(provider.callCount).toBe(1);
  });

  it("run fails with the status when the run does not submit, but still writes the report", async () => {
    const w = await workspace();
    const d = deps(new MockProvider([mockToolCall("b", "bash", { cmd: "ls" })]));
    await expect(executeCommand("run", { ...w.opts, plan: false }, d.deps)).rejects.toThrow(
      /status error/,
    );
    expect(await readdir(w.opts.runs)).toHaveLength(1);
  });

  it("plan: prints the plan and saves plan.json, with no fix phase", async () => {
    const w = await workspace();
    const provider = new MockProvider([mockToolCall("p", "submit_plan", plan)]);
    const d = deps(provider);
    await executeCommand("plan", w.opts, d.deps);
    expect(d.lines.join("\n")).toContain("root cause hypothesis: off by one");
    const [runId] = await readdir(w.opts.runs);
    expect(JSON.parse(await readFile(join(w.opts.runs, runId ?? "", "plan.json"), "utf8"))).toEqual(
      plan,
    );
  });

  it("destroys the sandbox even when the run throws", async () => {
    const w = await workspace();
    const fake = fakeSandbox();
    const destroy = vi.spyOn(fake.sandbox, "destroy");
    const d = deps(new MockProvider([]));
    d.deps.createSandbox = () => fake.sandbox;
    await expect(executeCommand("plan", w.opts, d.deps)).rejects.toThrow();
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe("cli options", () => {
  it("registers run and plan with the planned flags", () => {
    const program = buildProgram();
    const run = program.commands.find((c) => c.name() === "run");
    const flags = run?.options.map((o) => o.long) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining([
        "--repo",
        "--issue",
        "--model",
        "--plan-model",
        "--max-steps",
        "--max-cost",
        "--max-time",
        "--approve-plan",
        "--no-plan",
      ]),
    );
    expect(
      program.commands.find((c) => c.name() === "plan")?.options.map((o) => o.long),
    ).not.toContain("--no-plan");
  });

  it("rejects a non-positive budget", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerRun(program);
    await expect(
      program.parseAsync([
        "node",
        "iaso",
        "run",
        "--repo",
        "r",
        "--issue",
        "i",
        "--max-steps",
        "0",
      ]),
    ).rejects.toThrow(/--max-steps must be a number above 0/);
  });
});
