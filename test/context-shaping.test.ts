import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_MATCHES,
  classifyCommand,
  shapeCompilerOutput,
  shapeOutput,
  shapeSearchOutput,
  shapeTestOutput,
} from "../src/context/shaping.js";

describe("classifyCommand", () => {
  it.each([
    ["npm test", "test"],
    ["npx vitest run test/a.test.ts", "test"],
    ["python -m pytest -x", "test"],
    ["go test ./...", "test"],
    ["npm test | grep fail", "test"],
    ["grep -rn parseDate src", "search"],
    ["rg foo", "search"],
    ["npx tsc --noEmit", "build"],
    ["ls -la", "other"],
  ])("%s -> %s", (cmd, kind) => {
    expect(classifyCommand(cmd)).toBe(kind);
  });
});

describe("shapeTestOutput", () => {
  const nodeRun = [
    "✔ adds numbers (0.4ms)",
    "✔ subtracts numbers (0.2ms)",
    "✖ paginates last page (1.2ms)",
    "  AssertionError: expected 3 to equal 2",
    "      at paginate (/repo/src/page.js:12:9)",
    "      at TestContext.<anonymous> (/repo/test/page.test.js:8:3)",
    "      at Test.runInAsyncScope (node:internal/async_hooks:214:14)",
    "      at file:///repo/node_modules/foo/index.js:1:1",
    "ℹ tests 3",
    "ℹ pass 2",
    "ℹ fail 1",
  ].join("\n");

  it("drops passed lines and framework frames, keeps failures, repo frames and summary", () => {
    const res = shapeTestOutput(nodeRun);
    expect(res.shaped).toBe(true);
    expect(res.text).not.toContain("adds numbers");
    expect(res.text).not.toContain("node:internal");
    expect(res.text).not.toContain("node_modules");
    expect(res.text).toContain("✖ paginates last page");
    expect(res.text).toContain("AssertionError: expected 3 to equal 2");
    expect(res.text).toContain("/repo/src/page.js:12:9");
    expect(res.text).toContain("ℹ fail 1");
    expect(res.text).toMatch(/\[4 passed-test and framework lines omitted\]$/);
  });

  it("handles pytest verbose output and drops the source line under a library frame", () => {
    const raw = [
      "test_a.py::test_ok PASSED",
      "test_a.py::test_bad FAILED",
      "E   assert 3 == 2",
      '  File "/usr/lib/python3.11/unittest/case.py", line 10, in run',
      "    self._callTestMethod()",
      '  File "/repo/test_a.py", line 7, in test_bad',
      "    assert paginate() == 2",
      "=== 1 failed, 1 passed in 0.1s ===",
    ].join("\n");
    const res = shapeTestOutput(raw);
    expect(res.text).not.toContain("PASSED");
    expect(res.text).not.toContain("_callTestMethod");
    expect(res.text).toContain("/repo/test_a.py");
    expect(res.text).toContain("assert paginate() == 2");
    expect(res.text).toContain("E   assert 3 == 2");
    expect(res.text).toContain("1 failed, 1 passed");
  });

  it("returns output unchanged when there is nothing to drop", () => {
    const raw = "Error: cannot find module 'x'\n    at /repo/a.js:1:1";
    expect(shapeTestOutput(raw)).toEqual({ text: raw, shaped: false });
  });

  it("keeps lines it does not recognise", () => {
    const res = shapeTestOutput("✔ ok\nweird custom line");
    expect(res.text).toContain("weird custom line");
  });
});

describe("shapeCompilerOutput", () => {
  const errors = Array.from({ length: 8 }, (_, i) => [
    `src/f${String(i)}.ts(${String(i + 1)},5): error TS2322: Type 'string' is not assignable to type 'number'.`,
    "  Detail line for the error",
  ]).flat();
  const raw = ["> tsc --noEmit", ...errors, "Found 8 errors in 8 files."].join("\n");

  it("keeps the first error in full, errors 2 to 5 short, counts the rest, keeps the summary", () => {
    const res = shapeCompilerOutput(raw);
    expect(res.shaped).toBe(true);
    const lines = res.text.split("\n");
    expect(lines[0]).toContain("src/f0.ts(1,5)");
    expect(lines[1]).toBe("  Detail line for the error");
    expect(res.text).toContain("src/f4.ts");
    expect(res.text).not.toContain("src/f5.ts");
    expect(res.text.match(/Detail line/g)).toHaveLength(1);
    expect(res.text).toContain("[... and 3 more errors]");
    expect(res.text).toContain("Found 8 errors in 8 files.");
  });

  it("recognises gcc, go and rustc styles", () => {
    const raw = ["main.c:3:5: error: expected ';'", "main.c:9:1: error: unknown type"].join("\n");
    expect(shapeCompilerOutput(raw).text).toBe(raw);
    const rust =
      "error[E0308]: mismatched types\n --> src/a.rs:1:1\nerror[E0425]: not found\n --> src/b.rs:2:2";
    expect(shapeCompilerOutput(rust).shaped).toBe(true);
  });

  it("leaves a single error or non-error output alone", () => {
    const one = "a.ts(1,1): error TS1: boom";
    expect(shapeCompilerOutput(one)).toEqual({ text: one, shaped: false });
    expect(shapeCompilerOutput("all good")).toEqual({ text: "all good", shaped: false });
  });
});

describe("shapeSearchOutput", () => {
  it("groups matches by file", () => {
    const res = shapeSearchOutput("src/a.ts:3:  const x = 1\nsrc/a.ts:9:foo()\n./src/b.ts:2:bar");
    expect(res.text).toBe("src/a.ts\n  3: const x = 1\n  9: foo()\nsrc/b.ts\n  2: bar");
  });

  it("caps at 50 matches and says how many more exist", () => {
    const raw = Array.from(
      { length: 75 },
      (_, i) => `f${String(i % 5)}.ts:${String(i + 1)}:hit`,
    ).join("\n");
    const res = shapeSearchOutput(raw);
    expect(res.text.match(/: hit/g)).toHaveLength(MAX_SEARCH_MATCHES);
    expect(res.text).toContain("[25 more matches not shown. Narrow the search.]");
  });

  it("leaves output alone when any line is not a match line", () => {
    const raw = "src/a.ts:3:x\ngrep: warning: something";
    expect(shapeSearchOutput(raw)).toEqual({ text: raw, shaped: false });
    expect(shapeSearchOutput("")).toEqual({ text: "", shaped: false });
  });
});

describe("shapeOutput", () => {
  it("passes other output through untouched", () => {
    expect(shapeOutput("other", "anything")).toEqual({ text: "anything", shaped: false });
  });
});
