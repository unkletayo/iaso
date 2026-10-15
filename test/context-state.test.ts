import { describe, expect, it } from "vitest";
import {
  emptyTaskState,
  isEmptyPatch,
  mergeTaskState,
  newRunState,
  taskStatePatchSchema,
} from "../src/context/state.js";

describe("mergeTaskState", () => {
  it("starts empty in the plan phase", () => {
    expect(emptyTaskState().phase).toBe("plan");
    expect(newRunState().lastNotesStep).toBe(0);
  });

  it("replaces phase and hypothesis, keeps what the patch leaves out", () => {
    const s = mergeTaskState(
      emptyTaskState(),
      { phase: "fix", rootCauseHypothesis: "off by one" },
      3,
    );
    const next = mergeTaskState(s, { phase: "verify" }, 5);
    expect(next.phase).toBe("verify");
    expect(next.rootCauseHypothesis).toBe("off by one");
  });

  it("does not mutate its input", () => {
    const before = emptyTaskState();
    mergeTaskState(before, { todo: ["x"], confirmedFacts: ["f"] }, 2);
    expect(before).toEqual(emptyTaskState());
  });

  it("stamps facts with the step and keeps the first step for a repeated fact", () => {
    let s = mergeTaskState(emptyTaskState(), { confirmedFacts: ["loop stops early"] }, 4);
    s = mergeTaskState(s, { confirmedFacts: ["loop stops early (step 99)", "other"] }, 9);
    expect(s.confirmedFacts).toEqual(["loop stops early (step 4)", "other (step 9)"]);
  });

  it("upserts files and failed approaches by key, never dropping old ones", () => {
    let s = mergeTaskState(
      emptyTaskState(),
      {
        filesExamined: [{ path: "a.js", why: "entry" }],
        failedApproaches: [{ what: "bump limit", whyItFailed: "still fails" }],
      },
      1,
    );
    s = mergeTaskState(
      s,
      {
        filesExamined: [
          { path: "a.js", why: "has the bug" },
          { path: "b.js", why: "test" },
        ],
        failedApproaches: [{ what: "use <=", whyItFailed: "breaks other test" }],
      },
      2,
    );
    expect(s.filesExamined).toEqual([
      { path: "a.js", why: "has the bug" },
      { path: "b.js", why: "test" },
    ]);
    expect(s.failedApproaches.map((f) => f.what)).toEqual(["bump limit", "use <="]);
  });

  it("appends test runs as a history with the step added", () => {
    let s = mergeTaskState(
      emptyTaskState(),
      { testsRun: [{ cmd: "npm test", result: "fail" }] },
      3,
    );
    s = mergeTaskState(s, { testsRun: [{ cmd: "npm test", result: "pass" }] }, 7);
    expect(s.testsRun).toEqual([
      { cmd: "npm test", result: "fail", step: 3 },
      { cmd: "npm test", result: "pass", step: 7 },
    ]);
  });

  it("replaces todo, so items can be ticked off", () => {
    let s = mergeTaskState(emptyTaskState(), { todo: ["a", "b"] }, 1);
    s = mergeTaskState(s, { todo: ["b"] }, 2);
    expect(s.todo).toEqual(["b"]);
    s = mergeTaskState(s, { todo: [] }, 3);
    expect(s.todo).toEqual([]);
  });
});

describe("taskStatePatchSchema / isEmptyPatch", () => {
  it("rejects unknown fields, bad phases, and a step from the agent", () => {
    expect(taskStatePatchSchema.safeParse({ phase: "dance" }).success).toBe(false);
    expect(taskStatePatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(
      taskStatePatchSchema.safeParse({ testsRun: [{ cmd: "x", result: "pass", step: 1 }] }).success,
    ).toBe(false);
  });

  it("detects an empty patch", () => {
    expect(isEmptyPatch({})).toBe(true);
    expect(isEmptyPatch({ todo: [] })).toBe(false);
  });
});
