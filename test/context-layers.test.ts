import { describe, expect, it } from "vitest";
import {
  WORKING_SET_MAX_LINES,
  buildRequest,
  renderTaskState,
  renderWorkingSet,
  type LayerInput,
} from "../src/context/layers.js";
import { emptyTaskState, mergeTaskState } from "../src/context/state.js";
import type { Message } from "../src/providers/types.js";

function step(
  n: number,
  name = "bash",
  input: Record<string, unknown> = { cmd: "ls" },
  output = `out${String(n)}`,
): Message[] {
  const id = `c${String(n)}`;
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, input }] },
    { role: "user", content: [{ type: "tool_result", id, output, isError: false }] },
  ];
}

const base: LayerInput = {
  system: "SYSTEM",
  issue: "The paginator drops the last page.",
  state: emptyTaskState(),
  workingSet: [],
  history: [],
  tools: [],
  maxOutputTokens: 4096,
};

/** All text blocks of a message, joined. The context message has several. */
const firstText = (m: Message | undefined): string =>
  (m?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");

describe("buildRequest", () => {
  it("with no history sends one user message: issue then notes", () => {
    const { request } = buildRequest(base);
    expect(request.system).toBe("SYSTEM");
    expect(request.messages).toHaveLength(1);
    const text = firstText(request.messages[0]);
    expect(request.messages[0]?.role).toBe("user");
    expect(text.indexOf("## Issue")).toBeLessThan(text.indexOf("## Your notes"));
    expect(text).toContain("The paginator drops the last page.");
    expect(request.maxOutputTokens).toBe(4096);
    expect(request).not.toHaveProperty("temperature");
  });

  it("puts stable layers first: issue, plan, summary, notes, working set", () => {
    const { request } = buildRequest({
      ...base,
      plan: "PLAN-JSON",
      workingSet: [{ path: "/repo/a.js", content: "x\n" }],
      compactedSummary: "SUMMARY",
    });
    const text = firstText(request.messages[0]);
    const order = [
      "## Issue",
      "## Approved plan",
      "## Summary of earlier steps",
      "## Your notes",
      "## Files you edited",
    ];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("splits the context into blocks and puts cache breakpoints after the pinned layer and the summary", () => {
    const { request } = buildRequest({ ...base, plan: "P", compactedSummary: "S" });
    const blocks = request.messages[0]?.content ?? [];
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.type === "text" && b.cacheBreakpoint === true)).toEqual([
      true,
      true,
      false,
    ]);
    expect(JSON.stringify(blocks[0])).toContain("Approved plan");
    expect(JSON.stringify(blocks[1])).toContain("Summary of earlier steps");
    expect(JSON.stringify(blocks[2])).toContain("Your notes");
  });

  it("keeps the pinned and summary blocks byte-identical when only notes and files change", () => {
    const a = buildRequest({ ...base, plan: "P", compactedSummary: "S" }).request.messages[0];
    const b = buildRequest({
      ...base,
      plan: "P",
      compactedSummary: "S",
      state: { ...emptyTaskState(), todo: ["new"] },
      workingSet: [{ path: "/repo/a.js", content: "x\n" }],
    }).request.messages[0];
    expect(a?.content.slice(0, 2)).toEqual(b?.content.slice(0, 2));
    expect(a?.content[2]).not.toEqual(b?.content[2]);
  });

  it("numbers steps from firstStep when marking outdated reads", () => {
    const history = [
      ...step(1, "read_file", { path: "a.js" }, "OLD FILE"),
      ...step(2, "edit_file", { path: "a.js", oldText: "a", newText: "b" }, "Edited"),
    ];
    const flat = JSON.stringify(buildRequest({ ...base, history, firstStep: 10 }).request.messages);
    expect(flat).toContain("[outdated: file changed at step 11]");
  });

  it("appends history after the context message and alternates roles", () => {
    const { request } = buildRequest({ ...base, history: [...step(1), ...step(2)] });
    expect(request.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("keeps all history by default and reports nothing omitted", () => {
    const history = Array.from({ length: 12 }, (_, i) => step(i + 1)).flat();
    const res = buildRequest({ ...base, history });
    expect(res.omittedSteps).toBe(0);
    expect(res.request.messages).toHaveLength(1 + history.length);
  });

  it("keeps the last N steps and says how many earlier ones are not shown", () => {
    const history = Array.from({ length: 12 }, (_, i) => step(i + 1)).flat();
    const res = buildRequest({ ...base, history, recentSteps: 8 });
    expect(res.omittedSteps).toBe(4);
    expect(res.request.messages).toHaveLength(1 + 16);
    expect(res.request.messages[1]?.role).toBe("assistant");
    expect(firstText(res.request.messages[0])).toContain("[4 earlier steps are not shown.");
    const lastResult = res.request.messages.at(-1)?.content[0];
    expect(lastResult).toMatchObject({ type: "tool_result", output: "out12" });
  });

  it("prefers the compacted summary over the omitted-steps note", () => {
    const history = Array.from({ length: 3 }, (_, i) => step(i + 1)).flat();
    const text = firstText(
      buildRequest({ ...base, history, recentSteps: 1, compactedSummary: "S" }).request.messages[0],
    );
    expect(text).toContain("S");
    expect(text).not.toContain("earlier steps are not shown");
  });

  it("applies staleness to the whole history before trimming", () => {
    const history = [
      ...step(1, "read_file", { path: "a.js" }, "OLD FILE"),
      ...step(2, "edit_file", { path: "a.js", oldText: "a", newText: "b" }, "Edited"),
    ];
    const res = buildRequest({ ...base, history });
    expect(res.staleChanged).toBe(true);
    const flat = JSON.stringify(res.request.messages);
    expect(flat).not.toContain("OLD FILE");
    expect(flat).toContain("[outdated: file changed at step 2]");
  });

  it("is deterministic: same input, same bytes", () => {
    const input = {
      ...base,
      history: step(1),
      state: mergeTaskState(emptyTaskState(), { todo: ["x"] }, 1),
    };
    expect(JSON.stringify(buildRequest(input).request)).toBe(
      JSON.stringify(buildRequest(input).request),
    );
  });

  it("does not change the history it is given", () => {
    const history = [
      ...step(1, "read_file", { path: "a.js" }, "X"),
      ...step(2, "edit_file", { path: "a.js" }, "ok"),
    ];
    const snapshot = structuredClone(history);
    buildRequest({ ...base, history, recentSteps: 1 });
    expect(history).toEqual(snapshot);
  });
});

describe("renderTaskState", () => {
  it("shows every section, with (none) for empty lists", () => {
    const text = renderTaskState(emptyTaskState());
    expect(text).toContain("phase: plan");
    expect(text).toContain("root cause hypothesis: (none yet)");
    expect(text).toContain("failed approaches:\n(none)");
  });

  it("renders failed approaches with the reason and test runs with their step", () => {
    const state = mergeTaskState(
      emptyTaskState(),
      {
        failedApproaches: [{ what: "use <=", whyItFailed: "breaks the empty list case" }],
        testsRun: [{ cmd: "npm test", result: "fail" }],
        confirmedFacts: ["last page is dropped"],
      },
      4,
    );
    const text = renderTaskState(state);
    expect(text).toContain("- use <= (failed because: breaks the empty list case)");
    expect(text).toContain("- [fail] npm test (step 4)");
    expect(text).toContain("- last page is dropped (step 4)");
  });
});

describe("renderWorkingSet", () => {
  it("is empty with no files", () => {
    expect(renderWorkingSet([])).toBe("");
  });

  it("numbers lines and caps each file at 200 lines, pointing at read_file", () => {
    const content = Array.from({ length: 250 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const text = renderWorkingSet([{ path: "/repo/big.js", content }]);
    expect(text).toContain("### /repo/big.js (latest version, 250 lines)");
    expect(text).toContain("200\tline 200");
    expect(text).not.toContain("line 201");
    expect(text).toContain(
      `[50 more lines. Use read_file with startLine=${String(WORKING_SET_MAX_LINES + 1)}`,
    );
  });

  it("does not count a trailing newline as a line", () => {
    expect(renderWorkingSet([{ path: "/repo/a", content: "x\ny\n" }])).toContain(
      "(latest version, 2 lines)",
    );
  });
});
