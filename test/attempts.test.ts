import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AttemptsOptions, attemptDir, rank, runAttempts } from "../src/agent/attempts.js";
import { BUDGET_DEFAULTS } from "../src/config.js";
import type { Plan } from "../src/context/state.js";
import { MockProvider, type ScriptedStep, mockToolCall } from "../src/providers/mock.js";
import type { ExecResult, Sandbox } from "../src/sandbox/types.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const prices = { inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3 };
const plan: Plan = {
  rootCauseHypothesis: "off by one",
  filesToChange: [{ path: "src/a.js", change: "use <=" }],
  testPlan: "add a test",
  risks: [],
  steps: ["fix"],
};
const notes = mockToolCall("n", "notes", { testsRun: [{ cmd: "npm test", result: "pass" }] });
const submit = mockToolCall("s", "submit", {
  summary: "done",
  prTitle: "Fix it",
  prSummary: "Fixes it.",
  testsAdded: ["test/x.test.js"],
  confidence: "high",
});
const ok = (): ExecResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

/**
 * A sandbox whose git and test commands make the post-run check come out as asked:
 * `verified` (the test fails on the base and passes with the fix), `failed` (it passes on both),
 * or `not_checked` (no test file changed).
 */
function checkedSandbox(verdict: "verified" | "failed" | "not_checked"): Sandbox {
  let onBase = false;
  return fakeSandbox({}, (cmd) => {
    if (cmd.startsWith("git add -A && git diff --cached --name-only")) {
      return { ...ok(), stdout: verdict === "not_checked" ? "" : "test/x.test.js\n" };
    }
    if (cmd === "git add -A && git write-tree") return { ...ok(), stdout: "a".repeat(40) };
    if (cmd.startsWith("git restore --source=iaso-baseline")) onBase = true;
    else if (cmd.startsWith("git restore --source=")) onBase = false;
    if (cmd === "npm test") {
      const fails = onBase && verdict === "verified";
      return { ...ok(), exitCode: fails ? 1 : 0 };
    }
    return ok();
  }).sandbox;
}

let runDir = "";
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "iaso-attempts-"));
});

function options(
  verdicts: ("verified" | "failed" | "not_checked")[],
  script: ScriptedStep[],
  over: Partial<AttemptsOptions> = {},
) {
  const provider = new MockProvider(script);
  const sandboxes = verdicts.map(checkedSandbox);
  const created: number[] = [];
  const log: string[] = [];
  const opts: AttemptsOptions = {
    attempts: verdicts.length,
    limits: BUDGET_DEFAULTS,
    runDir,
    createSandbox: (attempt) => {
      created.push(attempt);
      const s = sandboxes[attempt - 1];
      if (s === undefined) throw new Error(`no sandbox for attempt ${String(attempt)}`);
      return s;
    },
    prepare: () => Promise.resolve({ network: "on", reason: "test" }),
    pipeline: { fix: { provider, prices }, issue: "ISSUE", usePlan: false },
    log: (l) => log.push(l),
    ...over,
  };
  return { opts, provider, created, log };
}

describe("rank", () => {
  it("orders verified above unchecked above failed above not submitted", () => {
    const sub = { status: "submitted" as const };
    const base = { planCostUsd: 0, planSteps: 0, costUsd: 0, steps: 0, diff: "" };
    const v = (status: "verified" | "failed" | "not_checked") => ({
      status,
      reproduction: { status: "not_checked" as const, reason: "" },
      suite: { status: "not_checked" as const, reason: "" },
    });
    expect(rank({ result: { ...base, ...sub }, verification: v("verified") })).toBe(3);
    expect(rank({ result: { ...base, ...sub }, verification: v("not_checked") })).toBe(2);
    expect(rank({ result: { ...base, ...sub }, verification: v("failed") })).toBe(1);
    expect(rank({ result: { ...base, status: "error" }, verification: v("verified") })).toBe(0);
  });
});

describe("runAttempts", () => {
  it("stops at the first attempt whose patch is verified", async () => {
    const o = options(["failed", "verified", "verified"], [notes, submit, notes, submit]);
    const out = await runAttempts(o.opts);
    expect(o.created).toEqual([1, 2]);
    expect(out.kept.attempt).toBe(2);
    expect(out.attempts.map((a) => a.verification.status)).toEqual(["failed", "verified"]);
    expect(out.stoppedBecause).toBeUndefined();
    const costs = out.attempts.map((a) => a.result.costUsd);
    expect(out.totalCostUsd).toBeCloseTo((costs[0] ?? 0) + (costs[1] ?? 0));
  });

  it("keeps the best attempt when none is verified, the earliest on a tie", async () => {
    const o = options(["failed", "not_checked", "not_checked"], [notes, submit, submit, submit]);
    const out = await runAttempts(o.opts);
    expect(o.created).toEqual([1, 2, 3]);
    expect(out.kept.attempt).toBe(2);
  });

  it("puts the kept attempt's files at the top of the run folder, and keeps every attempt's own", async () => {
    const o = options(["failed", "verified"], [notes, submit, notes, submit]);
    const out = await runAttempts(o.opts);
    expect(out.kept.dir).toBe(join(runDir, "attempt-2"));
    const top = await readFile(join(runDir, "trajectory.jsonl"), "utf8");
    const kept = await readFile(join(runDir, "attempt-2", "trajectory.jsonl"), "utf8");
    const first = await readFile(join(runDir, "attempt-1", "trajectory.jsonl"), "utf8");
    expect(top).toBe(kept);
    expect(top).not.toBe(first);
  });

  it("with one attempt uses the run folder itself", async () => {
    const o = options(["not_checked"], [submit]);
    const out = await runAttempts(o.opts);
    expect(out.kept.dir).toBe(runDir);
    expect(attemptDir("/r", 1, 1)).toBe("/r");
    expect(attemptDir("/r", 1, 2)).toBe(join("/r", "attempt-1"));
  });

  it("plans once and pins that plan for the later attempts", async () => {
    const o = options(
      ["not_checked", "not_checked"],
      [mockToolCall("p", "submit_plan", plan), submit, submit],
      {
        pipeline: {
          fix: { provider: new MockProvider([]), prices },
          issue: "ISSUE",
          usePlan: true,
        },
      },
    );
    o.opts.pipeline = { ...o.opts.pipeline, fix: { provider: o.provider, prices } };
    const out = await runAttempts(o.opts);
    expect(o.provider.callCount).toBe(3);
    expect(out.attempts[1]?.result.plan).toEqual(plan);
    expect(out.attempts[1]?.result.planSteps).toBe(0);
    expect(JSON.stringify(o.provider.requests[2]?.messages[0])).toContain("off by one");
  });

  it("stops when the plan was rejected", async () => {
    const o = options(["not_checked", "not_checked"], [mockToolCall("p", "submit_plan", plan)], {
      pipeline: {
        fix: { provider: new MockProvider([]), prices },
        issue: "ISSUE",
        usePlan: true,
        review: () => Promise.resolve({ kind: "reject" }),
      },
    });
    o.opts.pipeline = { ...o.opts.pipeline, fix: { provider: o.provider, prices } };
    const out = await runAttempts(o.opts);
    expect(o.created).toEqual([1]);
    expect(out.kept.result.status).toBe("plan_rejected");
    expect(out.stoppedBecause).toBe("the plan was not approved");
  });

  it("starts no attempt once the time or the cost is nearly gone", async () => {
    let t = 0;
    const o = options(["failed", "verified"], [notes, submit], {
      limits: { ...BUDGET_DEFAULTS, maxTimeMinutes: 10 },
      now: () => t,
    });
    const slow = o.opts.createSandbox;
    o.opts.createSandbox = (attempt) => {
      t += 11 * 60_000;
      return slow(attempt);
    };
    const out = await runAttempts(o.opts);
    expect(o.created).toEqual([1]);
    expect(out.stoppedBecause).toBe("the time limit was reached");

    const cheap = options(["failed", "verified"], [notes, submit], {
      limits: { ...BUDGET_DEFAULTS, maxCostUsd: 0.0001 },
    });
    const outCheap = await runAttempts(cheap.opts);
    expect(cheap.created).toEqual([1]);
    expect(outCheap.stoppedBecause).toMatch(/of the cost limit was left/);
  });

  it("destroys every sandbox, and tells the model when an attempt's network is off", async () => {
    const o = options(["not_checked", "not_checked"], [submit, submit], {
      prepare: () => Promise.resolve({ network: "off", installCommand: "npm ci" }),
    });
    const destroyed: number[] = [];
    const make = o.opts.createSandbox;
    o.opts.createSandbox = (attempt) => {
      const s = make(attempt);
      s.destroy = vi.fn(() => {
        destroyed.push(attempt);
        return Promise.resolve();
      });
      return s;
    };
    const out = await runAttempts(o.opts);
    expect(destroyed).toEqual([1, 2]);
    expect(out.kept.network).toEqual({ network: "off", installCommand: "npm ci" });
    expect(o.provider.requests[0]?.system).toContain("The sandbox has no network.");
  });
});
