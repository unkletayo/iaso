import { describe, expect, it } from "vitest";
import { LoopDetector, type ObservedCall, failureFingerprint } from "../src/context/loops.js";

const bash = (cmd: string, output = "exit code: 0\n(no output)"): ObservedCall => ({
  name: "bash",
  input: { cmd },
  output,
  isError: false,
});
const edit = (path: string, oldText: string, newText: string, isError = false): ObservedCall => ({
  name: "edit_file",
  input: { path, oldText, newText },
  output: isError ? "no match" : "edited",
  isError,
});
const failing = (n: number, ms = 12): ObservedCall =>
  bash(
    "node --test",
    `exit code: 1\nnot ok 1 - sumRange\n  expected 15 got 10\n# duration_ms ${String(ms + n)}`,
  );

function run(d: LoopDetector, calls: ObservedCall[]): ReturnType<LoopDetector["observe"]>[] {
  return calls.map((c) => d.observe(c));
}

describe("LoopDetector: commands", () => {
  it("flags the third identical command, ignoring spacing", () => {
    const out = run(new LoopDetector(), [bash("ls  -la"), bash("ls -la"), bash(" ls -la ")]);
    expect(out.map((r) => r?.kind ?? null)).toEqual([null, null, "command"]);
    expect(out[2]?.count).toBe(3);
  });

  it("keeps flagging on every further repeat", () => {
    const out = run(
      new LoopDetector(),
      Array.from({ length: 5 }, () => bash("ls")),
    );
    expect(out.map((r) => r?.count ?? 0)).toEqual([0, 0, 3, 4, 5]);
  });

  it("does not count different commands together", () => {
    const out = run(new LoopDetector(), [bash("ls"), bash("pwd"), bash("ls"), bash("pwd")]);
    expect(out.every((r) => r === null)).toBe(true);
  });

  it("resets command counts after a successful edit", () => {
    const d = new LoopDetector();
    const out = run(d, [bash("cat a"), bash("cat a"), edit("a", "x", "y"), bash("cat a")]);
    expect(out.every((r) => r === null)).toBe(true);
  });

  it("does not reset command counts after a failed edit", () => {
    const out = run(new LoopDetector(), [
      bash("cat a"),
      bash("cat a"),
      edit("a", "x", "y", true),
      bash("cat a"),
    ]);
    expect(out[3]?.kind).toBe("command");
  });

  it("ignores tools other than bash and edit_file", () => {
    const d = new LoopDetector();
    const read: ObservedCall = {
      name: "read_file",
      input: { path: "a" },
      output: "x",
      isError: false,
    };
    expect(run(d, [read, read, read, read]).every((r) => r === null)).toBe(true);
  });
});

describe("LoopDetector: edits", () => {
  it("flags the third identical edit, even across other edits", () => {
    const out = run(new LoopDetector(), [
      edit("a", "x", "y", true),
      edit("b", "p", "q"),
      edit("a", "x", "y", true),
      edit("a", "x", "y", true),
    ]);
    expect(out.map((r) => r?.kind ?? null)).toEqual([null, null, null, "edit"]);
    expect(out[3]?.description).toContain("a");
  });

  it("treats a different replacement as a different edit", () => {
    const out = run(new LoopDetector(), [
      edit("a", "x", "1", true),
      edit("a", "x", "2", true),
      edit("a", "x", "3", true),
    ]);
    expect(out.every((r) => r === null)).toBe(true);
  });
});

describe("LoopDetector: test failures", () => {
  it("flags the same failure 3 times even though the timing differs and edits came between", () => {
    const out = run(new LoopDetector(), [
      failing(1),
      edit("a", "1", "2"),
      failing(2, 40),
      edit("a", "2", "3"),
      failing(3, 99),
    ]);
    expect(out[4]?.kind).toBe("test_failure");
    expect(out[4]?.count).toBe(3);
  });

  it("flags it across different command lines", () => {
    const out = run(new LoopDetector(), [
      bash("node --test", failing(0).output),
      bash("node --test test/range.test.js", failing(0).output),
      bash("npm test", failing(0).output),
    ]);
    expect(out[2]?.kind).toBe("test_failure");
  });

  it("does not count a different failure as the same", () => {
    const out = run(new LoopDetector(), [
      bash("node --test a", "exit code: 1\nnot ok 1 - a\n  expected 15 got 10"),
      bash("node --test b", "exit code: 1\nnot ok 1 - a\n  expected 15 got 12"),
      bash("node --test c", "exit code: 1\nnot ok 1 - a\n  expected 15 got 14"),
    ]);
    expect(out.every((r) => r === null)).toBe(true);
  });

  it("does not count passing runs or non-test commands that fail", () => {
    const out = run(new LoopDetector(), [
      bash("node --test", "exit code: 0\nok"),
      bash("node --test", "exit code: 0\nok"),
      bash("ls nope", "exit code: 2\nnope"),
      bash("ls nope2", "exit code: 2\nnope"),
      bash("ls nope3", "exit code: 2\nnope"),
    ]);
    expect(out.every((r) => r === null)).toBe(true);
  });

  it("uses a custom threshold", () => {
    const out = run(new LoopDetector(2), [bash("ls"), bash("ls")]);
    expect(out[1]?.kind).toBe("command");
  });
});

describe("failureFingerprint", () => {
  it("ignores durations and timestamps but keeps the assertion", () => {
    const a = failureFingerprint(
      "fail 1\nduration_ms 12.5\n2026-10-16T17:05:09.123Z\n(34ms)\nexpected 15 got 10",
    );
    const b = failureFingerprint(
      "fail 1\nduration_ms 99.1\n2026-10-17T01:00:00.000Z\n(5ms)\nexpected 15 got 10",
    );
    expect(a).toBe(b);
    expect(a).toContain("expected 15 got 10");
  });
});
