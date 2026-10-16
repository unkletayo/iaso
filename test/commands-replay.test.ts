import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import {
  executeReplay,
  renderMessages,
  renderTrajectory,
  replayContext,
} from "../src/commands/replay.js";
import { NO_TOOL_NUDGE } from "../src/agent/prompts.js";
import type { TrajectoryStep } from "../src/telemetry/trajectory.js";
import { TrajectoryWriter } from "../src/telemetry/trajectory.js";

function logged(n: number, over: Partial<TrajectoryStep> = {}): TrajectoryStep {
  return {
    step: n,
    phase: "fix",
    model: "mock",
    promptVersion: "1",
    tokens: { input: 10, output: 5, cachedInput: 0 },
    contextTokens: 100,
    response: { text: `thinking ${String(n)}`, stopReason: "tool_use" },
    toolCalls: [{ id: `c${String(n)}`, name: "bash", input: { cmd: `echo ${String(n)}` } }],
    toolResults: [{ id: `c${String(n)}`, name: "bash", output: `out${String(n)}`, isError: false }],
    costUsd: 0.001,
    durationMs: 12,
    ...over,
  };
}

const steps = (count: number): TrajectoryStep[] =>
  Array.from({ length: count }, (_, i) => logged(i + 1));

const text = (messages: ReturnType<typeof replayContext>["messages"]): string =>
  renderMessages(messages);

describe("renderTrajectory", () => {
  it("prints each step with its calls, results and context events", () => {
    const out = renderTrajectory([
      logged(1),
      logged(2, {
        contextEvents: [
          { kind: "compact", tokensBefore: 900, droppedSteps: 1, firstStep: 2, costUsd: 0.01 },
        ],
        toolResults: [{ id: "c2", name: "bash", output: "boom", isError: true }],
      }),
      logged(3, { toolCalls: [], toolResults: [] }),
    ]);
    expect(out).toContain("step 1 [fix] mock");
    expect(out).toContain("call bash");
    expect(out).toContain("result: out1");
    expect(out).toContain("error: boom");
    expect(out).toContain("context: compact, was ~900 tokens, dropped 1 steps");
    expect(out).toContain("(no tool call, stop reason tool_use)");
  });
});

describe("replayContext", () => {
  const base = { issue: "THE ISSUE", plan: "THE PLAN" };

  it("shows the issue, the plan and every earlier step, but not the step itself", () => {
    const res = replayContext({ steps: steps(4), step: 3, ...base });
    const out = text(res.messages);
    expect(out).toContain("THE ISSUE");
    expect(out).toContain("THE PLAN");
    expect(out).toContain("echo 1");
    expect(out).toContain("echo 2");
    expect(out).not.toContain("echo 3");
    expect(res.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("starts after the last compaction and puts its summary first", () => {
    const withCompaction = steps(5).map((s) =>
      s.step === 4
        ? {
            ...s,
            contextEvents: [
              {
                kind: "compact" as const,
                tokensBefore: 900,
                droppedSteps: 2,
                firstStep: 3,
                summary: "SUMMARY TEXT",
                costUsd: 0.01,
              },
            ],
          }
        : s,
    );
    const res = replayContext({ steps: withCompaction, step: 5, ...base });
    const out = text(res.messages);
    expect(res.firstStep).toBe(3);
    expect(out).toContain("SUMMARY TEXT");
    expect(out).not.toContain("echo 1");
    expect(out).not.toContain("echo 2");
    expect(out).toContain("echo 3");
    expect(out).toContain("echo 4");
    // The compaction logged on step 4 already applies to step 4's own request.
    const at4 = text(replayContext({ steps: withCompaction, step: 4, ...base }).messages);
    expect(at4).toContain("SUMMARY TEXT");
    expect(at4).not.toContain("echo 2");
    const at3 = text(replayContext({ steps: withCompaction, step: 3, ...base }).messages);
    expect(at3).not.toContain("SUMMARY TEXT");
  });

  it("drops the summary when the log says it was dropped", () => {
    const list = steps(4).map((s) => {
      if (s.step === 2)
        return {
          ...s,
          contextEvents: [
            {
              kind: "compact" as const,
              tokensBefore: 9,
              droppedSteps: 1,
              firstStep: 2,
              summary: "OLD",
              costUsd: 0,
            },
          ],
        };
      if (s.step === 3)
        return {
          ...s,
          contextEvents: [
            {
              kind: "drop_summary" as const,
              tokensBefore: 9,
              droppedSteps: 0,
              firstStep: 2,
              costUsd: 0,
            },
          ],
        };
      return s;
    });
    expect(text(replayContext({ steps: list, step: 4, ...base }).messages)).not.toContain("OLD");
  });

  it("rebuilds the notes from successful notes calls", () => {
    const notes = logged(1, {
      toolCalls: [{ id: "n1", name: "notes", input: { rootCauseHypothesis: "off by one" } }],
      toolResults: [{ id: "n1", name: "notes", output: "Notes updated (step 1).", isError: false }],
    });
    const failed = logged(2, {
      toolCalls: [{ id: "n2", name: "notes", input: { rootCauseHypothesis: "WRONG" } }],
      toolResults: [{ id: "n2", name: "notes", output: "bad", isError: true }],
    });
    const out = text(
      replayContext({ steps: [notes, failed, logged(3)], step: 3, ...base }).messages,
    );
    expect(out).toContain("root cause hypothesis: off by one");
    expect(out).not.toContain("WRONG\n");
  });

  it("restores the no-tool nudge the loop sent", () => {
    const list = [logged(1, { toolCalls: [], toolResults: [] }), logged(2)];
    expect(text(replayContext({ steps: list, step: 2, ...base }).messages)).toContain(
      NO_TOOL_NUDGE,
    );
  });
});

describe("executeReplay", () => {
  async function runDir() {
    const runs = await mkdtemp(join(tmpdir(), "iaso-replay-"));
    await mkdir(join(runs, "r1"));
    const writer = new TrajectoryWriter(join(runs, "r1", "trajectory.jsonl"));
    for (const s of steps(3)) await writer.append(s);
    await writeFile(join(runs, "r1", "issue.md"), "SAVED ISSUE");
    return runs;
  }

  it("prints the trajectory, or the context at one step", async () => {
    const runs = await runDir();
    const lines: string[] = [];
    await executeReplay("r1", { runs }, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("step 3 [fix]");
    lines.length = 0;
    await executeReplay("r1", { runs, context: 2 }, (l) => lines.push(l));
    expect(lines.join("\n")).toContain("SAVED ISSUE");
    expect(lines.join("\n")).toContain("echo 1");
  });

  it("rejects a step outside the run, and a missing run", async () => {
    const runs = await runDir();
    await expect(executeReplay("r1", { runs, context: 9 }, () => undefined)).rejects.toThrow(
      "from 1 to 3",
    );
    await expect(executeReplay("nope", { runs }, () => undefined)).rejects.toThrow();
  });

  it("is registered on the CLI with --context", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "replay");
    expect(cmd?.options.map((o) => o.long)).toEqual(["--runs", "--context"]);
  });
});
