import { describe, expect, it } from "vitest";
import { newRunState } from "../src/context/state.js";
import type { Sandbox } from "../src/sandbox/types.js";
import { notesTool } from "../src/tools/notes.js";
import { runTool } from "../src/tools/schema.js";
import { submitTool } from "../src/tools/submit.js";

const unused = (): Promise<never> => Promise.reject(new Error("not used in this test"));
const sandbox: Sandbox = {
  start: unused,
  exec: unused,
  readFile: unused,
  writeFile: unused,
  diff: unused,
  setNetwork: unused,
  destroy: unused,
};

describe("notes tool", () => {
  it("merges the patch into run state and records the step", async () => {
    const run = newRunState();
    const res = await runTool(
      notesTool,
      { phase: "reproduce", confirmedFacts: ["test fails"] },
      { sandbox, step: 6, run },
    );
    expect(res).toEqual({ output: "Notes updated (step 6).", isError: false });
    expect(run.task.phase).toBe("reproduce");
    expect(run.task.confirmedFacts).toEqual(["test fails (step 6)"]);
    expect(run.lastNotesStep).toBe(6);
  });

  it("rejects an empty patch without touching state", async () => {
    const run = newRunState();
    const res = await runTool(notesTool, {}, { sandbox, step: 2, run });
    expect(res.isError).toBe(true);
    expect(run.lastNotesStep).toBe(0);
  });

  it("rejects invalid input and leaves state alone", async () => {
    const run = newRunState();
    const res = await runTool(notesTool, { phase: "dance" }, { sandbox, step: 2, run });
    expect(res.isError).toBe(true);
    expect(run.task.phase).toBe("plan");
  });

  it("errors when the run provides no state", async () => {
    const res = await runTool(notesTool, { todo: ["x"] }, { sandbox, step: 1 });
    expect(res).toEqual({ output: "notes is not available in this run.", isError: true });
  });
});

const omit = <T extends object>(o: T, key: keyof T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as Partial<T>;

describe("submit tool", () => {
  const input = {
    summary: "fixed off-by-one",
    prTitle: "Include the last item in range",
    prSummary: "The loop stopped one short. It now includes the last item.",
    assumptions: ["An empty range returns 0; the issue does not say."],
    testsAdded: ["test/a.test.js"],
    confidence: "high",
  };

  it("records the submission with the step", async () => {
    const run = newRunState();
    const res = await runTool(submitTool, input, { sandbox, step: 12, run });
    expect(res.isError).toBe(false);
    expect(run.submission).toEqual({ ...input, step: 12 });
  });

  it("takes no assumptions as an empty list", async () => {
    const run = newRunState();
    const res = await runTool(submitTool, omit(input, "assumptions"), { sandbox, step: 3, run });
    expect(res.isError).toBe(false);
    expect(run.submission?.assumptions).toEqual([]);
  });

  it("requires a PR title and summary, and keeps the title to one line's length", async () => {
    const run = newRunState();
    for (const bad of [
      omit(input, "prTitle"),
      omit(input, "prSummary"),
      { ...input, prTitle: "x".repeat(101) },
    ]) {
      expect((await runTool(submitTool, bad, { sandbox, step: 1, run })).isError).toBe(true);
    }
    expect(run.submission).toBeUndefined();
  });

  it("rejects a second submit and keeps the first", async () => {
    const run = newRunState();
    await runTool(submitTool, input, { sandbox, step: 12, run });
    const res = await runTool(
      submitTool,
      { ...input, summary: "again" },
      { sandbox, step: 13, run },
    );
    expect(res).toEqual({ output: "Already submitted.", isError: true });
    expect(run.submission?.summary).toBe("fixed off-by-one");
  });

  it("rejects bad confidence, empty summary and missing fields", async () => {
    const run = newRunState();
    for (const bad of [
      { ...input, confidence: "certain" },
      { ...input, summary: "" },
      { ...input, assumptions: [""] },
      { summary: "x" },
    ]) {
      expect((await runTool(submitTool, bad, { sandbox, step: 1, run })).isError).toBe(true);
    }
    expect(run.submission).toBeUndefined();
  });

  it("errors when the run provides no state", async () => {
    const res = await runTool(submitTool, input, { sandbox, step: 1 });
    expect(res.isError).toBe(true);
  });
});
