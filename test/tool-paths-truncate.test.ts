import { describe, expect, it } from "vitest";
import { PathError, resolveRepoPath } from "../src/tools/paths.js";
import { truncateOutput } from "../src/tools/truncate.js";

describe("resolveRepoPath", () => {
  it("resolves relative paths against /repo", () => {
    expect(resolveRepoPath("src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolveRepoPath("./src/../a.ts")).toBe("/repo/a.ts");
    expect(resolveRepoPath(".")).toBe("/repo");
  });

  it("accepts absolute paths inside /repo", () => {
    expect(resolveRepoPath("/repo")).toBe("/repo");
    expect(resolveRepoPath("/repo/x/y.txt")).toBe("/repo/x/y.txt");
  });

  it("rejects paths outside /repo, including traversal and lookalike prefixes", () => {
    for (const bad of [
      "/etc/passwd",
      "../x",
      "src/../../etc",
      "/repo/../etc",
      "/repository/a",
      "/",
    ]) {
      expect(() => resolveRepoPath(bad), bad).toThrow(PathError);
    }
  });

  it("rejects empty paths and NUL bytes", () => {
    expect(() => resolveRepoPath("")).toThrow(/empty/);
    expect(() => resolveRepoPath("a\0b")).toThrow(/NUL/);
  });

  it("names the offending path in the error", () => {
    expect(() => resolveRepoPath("/etc/passwd")).toThrow(/\/etc\/passwd/);
  });
});

describe("truncateOutput", () => {
  it("returns short text unchanged, including exactly 10,000 characters", () => {
    expect(truncateOutput("hello")).toBe("hello");
    const edge = "a".repeat(10_000);
    expect(truncateOutput(edge)).toBe(edge);
  });

  it("keeps the first 4,000 and last 4,000 characters and reports the cut", () => {
    const text = "H".repeat(4_000) + "M".repeat(5_000) + "T".repeat(4_000);
    const out = truncateOutput(text);
    expect(out.startsWith("H".repeat(4_000))).toBe(true);
    expect(out.endsWith("T".repeat(4_000))).toBe(true);
    expect(out).toContain("[... 5000 characters cut ...]");
    expect(out).not.toContain("M");
  });

  it("truncates just over the limit", () => {
    const out = truncateOutput("x".repeat(10_001));
    expect(out).toContain("[... 2001 characters cut ...]");
  });

  it("does not split a surrogate pair at the boundaries", () => {
    const text = "a".repeat(3_999) + "😀" + "b".repeat(5_000) + "😀" + "a".repeat(3_999);
    const out = truncateOutput(text);
    // Every surrogate in the result must be part of a complete pair.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(out)).toBe(false);
    expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(false);
  });

  it("respects custom limits", () => {
    const out = truncateOutput("0123456789", { maxChars: 5, headChars: 2, tailChars: 2 });
    expect(out).toBe("01\n[... 6 characters cut ...]\n89");
  });
});
