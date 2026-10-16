import { describe, expect, it } from "vitest";
import {
  COMPACTOR_INPUT_CHARS,
  COMPACTOR_RESULT_CHARS,
  CompactionError,
  compactSteps,
  mergeSummaryIntoState,
  renderStepsForCompactor,
  renderSummary,
  splitSteps,
  type StepSummary,
} from "../src/context/compaction.js";
import { emptyTaskState } from "../src/context/state.js";
import { MockProvider, mockText, mockToolCall } from "../src/providers/mock.js";
import type { Message } from "../src/providers/types.js";

const prices = { inputPrice: 1, outputPrice: 5, cachedInputPrice: 0.1 };

function step(n: number, output = `out${String(n)}`, isError = false): Message[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: `c${String(n)}`, name: "bash", input: { cmd: `cmd${String(n)}` } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", id: `c${String(n)}`, output, isError }] },
  ];
}
const steps = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => step(i + 1)).flat();

const summary: StepSummary = {
  learned: ["sumRange loops to end exclusive"],
  files: [{ path: "src/range.js", why: "the bug is on line 4" }],
  tests: ["node --test: 1 fail"],
  failedApproaches: [{ what: "swap args", whyItFailed: "wrong side" }],
};

describe("splitSteps", () => {
  it("keeps the last N steps whole, starting at an assistant message", () => {
    const { old, recent, oldSteps } = splitSteps(steps(10), 3);
    expect(oldSteps).toBe(7);
    expect(old).toHaveLength(14);
    expect(recent).toHaveLength(6);
    expect(recent[0]?.role).toBe("assistant");
    expect(JSON.stringify(recent[0])).toContain("cmd8");
  });

  it("leaves everything recent when there are N steps or fewer", () => {
    const res = splitSteps(steps(3), 8);
    expect(res.old).toEqual([]);
    expect(res.recent).toHaveLength(6);
    expect(res.oldSteps).toBe(0);
  });

  it("keeps nothing recent when asked for 0", () => {
    const res = splitSteps(steps(2), 0);
    expect(res.recent).toEqual([]);
    expect(res.oldSteps).toBe(2);
  });
});

describe("renderStepsForCompactor", () => {
  it("numbers steps from firstStep and shows calls and results", () => {
    const text = renderStepsForCompactor(steps(2), 5);
    expect(text).toContain("### step 5");
    expect(text).toContain("### step 6");
    expect(text).toContain('call bash {"cmd":"cmd1"}');
    expect(text).toContain("result: out2");
  });

  it("marks errors, drops user nudge text, and cuts long results", () => {
    const messages: Message[] = [
      ...step(1, "x".repeat(COMPACTOR_RESULT_CHARS + 500), true),
      { role: "user", content: [{ type: "text", text: "NUDGE TEXT" }] },
    ];
    const text = renderStepsForCompactor(messages, 1);
    expect(text).toContain("result (error):");
    expect(text).toContain("[cut: 500 more characters]");
    expect(text).not.toContain("NUDGE TEXT");
  });

  it("keeps only the newest part when the whole thing is too big", () => {
    const big = Array.from({ length: 400 }, (_, i) =>
      step(i + 1, "y".repeat(COMPACTOR_RESULT_CHARS)),
    ).flat();
    const text = renderStepsForCompactor(big, 1);
    expect(text.length).toBeLessThan(COMPACTOR_INPUT_CHARS + 200);
    expect(text).toMatch(/^\[earlier steps cut/);
    expect(text).toContain("### step 400");
  });
});

describe("renderSummary", () => {
  it("renders the four sections in a fixed order", () => {
    const text = renderSummary(summary);
    const at = ["learned:", "files and lines that matter:", "tests run:", "failed approaches:"].map(
      (h) => text.indexOf(h),
    );
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("swap args (failed because: wrong side)");
  });

  it("says (none) for empty sections", () => {
    expect(renderSummary({ learned: [], files: [], tests: [], failedApproaches: [] })).toContain(
      "learned:\n(none)",
    );
  });
});

describe("mergeSummaryIntoState", () => {
  it("adds facts stamped with the last compacted step and keeps what the state had", () => {
    const state = {
      ...emptyTaskState(),
      rootCauseHypothesis: "H",
      confirmedFacts: ["old fact (step 2)"],
      failedApproaches: [{ what: "kept", whyItFailed: "k" }],
    };
    const merged = mergeSummaryIntoState(state, summary, 12);
    expect(merged.confirmedFacts).toEqual([
      "old fact (step 2)",
      "sumRange loops to end exclusive (step 12)",
    ]);
    expect(merged.filesExamined).toEqual(summary.files);
    expect(merged.failedApproaches.map((f) => f.what)).toEqual(["kept", "swap args"]);
    expect(merged.rootCauseHypothesis).toBe("H");
  });
});

describe("compactSteps", () => {
  const input = (provider: MockProvider) => ({
    provider,
    prices,
    old: steps(4),
    firstStep: 3,
    previousSummary: "PREVIOUS SUMMARY",
    state: emptyTaskState(),
  });

  it("asks for record_summary with the previous summary and old steps, and returns the merge", async () => {
    const provider = new MockProvider([mockToolCall("r", "record_summary", summary)]);
    const res = await compactSteps(input(provider));
    expect(res.structured).toEqual(summary);
    expect(res.summary).toBe(renderSummary(summary));
    // 4 steps starting at step 3 end at step 6.
    expect(res.state.confirmedFacts).toEqual(["sumRange loops to end exclusive (step 6)"]);
    expect(res.costUsd).toBeCloseTo((10 * 1 + 5 * 5) / 1_000_000);
    const req = provider.requests[0];
    expect(req?.tools.map((t) => t.name)).toEqual(["record_summary"]);
    const sent = JSON.stringify(req?.messages[0]);
    expect(sent).toContain("PREVIOUS SUMMARY");
    expect(sent).toContain("### step 3");
  });

  it("says (none yet) when there is no previous summary", async () => {
    const provider = new MockProvider([mockToolCall("r", "record_summary", summary)]);
    await compactSteps({ ...input(provider), previousSummary: undefined });
    expect(JSON.stringify(provider.requests[0]?.messages[0])).toContain("(none yet)");
  });

  it("retries once when the model answers in text, and adds the costs", async () => {
    const provider = new MockProvider([
      mockText("here you go"),
      mockToolCall("r", "record_summary", summary),
    ]);
    const res = await compactSteps(input(provider));
    expect(res.structured).toEqual(summary);
    expect(res.usage.inputTokens).toBe(20);
    expect(provider.callCount).toBe(2);
    expect(JSON.stringify(provider.requests[1]?.messages.at(-1))).toContain("Call record_summary");
  });

  it("answers an invalid call with an error result, then accepts a valid one", async () => {
    const provider = new MockProvider([
      mockToolCall("bad", "record_summary", { learned: "not a list" }),
      mockToolCall("r", "record_summary", summary),
    ]);
    const res = await compactSteps(input(provider));
    expect(res.structured).toEqual(summary);
    const last = provider.requests[1]?.messages.at(-1);
    expect(last?.content[0]).toMatchObject({ type: "tool_result", id: "bad", isError: true });
  });

  it("throws CompactionError after two bad answers", async () => {
    const provider = new MockProvider([mockText("no"), mockText("still no")]);
    await expect(compactSteps(input(provider))).rejects.toThrow(CompactionError);
    expect(provider.callCount).toBe(2);
  });
});
