import { describe, expect, it } from "vitest";
import type { ExecResult, Sandbox } from "../src/sandbox/types.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { MAX_READ_LINES, readFileTool } from "../src/tools/read-file.js";
import { type Tool, type ToolContext, runTool } from "../src/tools/schema.js";

const unused = (): Promise<never> => Promise.reject(new Error("not used in this test"));

/** In-memory sandbox: just enough filesystem for read_file and edit_file. */
function memorySandbox(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const sandbox: Sandbox = {
    start: unused,
    destroy: unused,
    diff: unused,
    setNetwork: unused,
    exec: (cmd): Promise<ExecResult> => {
      // edit_file only issues `test -e '<path>'`.
      const match = /^test -e '(.*)'$/.exec(cmd);
      const exists = match?.[1] !== undefined && files.has(match[1].replaceAll("'\\''", "'"));
      return Promise.resolve({ exitCode: exists ? 0 : 1, stdout: "", stderr: "", timedOut: false });
    },
    readFile: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Promise.reject(new Error(`Cannot read ${path}: No such file or directory`))
        : Promise.resolve(content);
    },
    writeFile: (path, content) => {
      files.set(path, content);
      writes.push(path);
      return Promise.resolve();
    },
  };
  const ctx: ToolContext = { sandbox, step: 1 };
  return { files, writes, ctx };
}

const run = (tool: Tool, input: unknown, ctx: ToolContext) => runTool(tool, input, ctx);

function numbered(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${String(i + 1)}`).join("\n") + "\n";
}

describe("read_file", () => {
  it("returns numbered lines with a header, resolving relative paths against /repo", async () => {
    const { ctx } = memorySandbox({ "/repo/a.txt": "alpha\nbeta\ngamma\n" });
    const res = await run(readFileTool, { path: "a.txt" }, ctx);
    expect(res.isError).toBe(false);
    expect(res.output).toBe("/repo/a.txt (lines 1-3 of 3)\n1\talpha\n2\tbeta\n3\tgamma");
  });

  it("does not count a trailing newline as an extra line", async () => {
    const { ctx } = memorySandbox({ "/repo/a": "x\n", "/repo/b": "x" });
    expect((await run(readFileTool, { path: "a" }, ctx)).output).toContain("of 1)");
    expect((await run(readFileTool, { path: "b" }, ctx)).output).toContain("of 1)");
  });

  it("reads an inclusive range", async () => {
    const { ctx } = memorySandbox({ "/repo/f": numbered(10) });
    const res = await run(readFileTool, { path: "f", startLine: 3, endLine: 5 }, ctx);
    expect(res.output).toBe(
      "/repo/f (lines 3-5 of 10)\n3\tline 3\n4\tline 4\n5\tline 5\n[5 more lines. Use startLine=6 to continue.]",
    );
  });

  it("pads line numbers to the widest number in the range", async () => {
    const { ctx } = memorySandbox({ "/repo/f": numbered(12) });
    const res = await run(readFileTool, { path: "f", startLine: 9, endLine: 11 }, ctx);
    expect(res.output).toContain(" 9\tline 9\n10\tline 10\n11\tline 11");
  });

  it("limits a call to 400 lines and tells the model how to continue", async () => {
    const { ctx } = memorySandbox({ "/repo/big": numbered(1000) });
    const res = await run(readFileTool, { path: "big" }, ctx);
    expect(MAX_READ_LINES).toBe(400);
    expect(res.output).toContain("(lines 1-400 of 1000)");
    expect(res.output).toContain("400\tline 400");
    expect(res.output).not.toContain("401\tline 401");
    expect(res.output).toContain(
      "600 more lines. Output is limited to 400 lines per call. Use startLine=401",
    );
  });

  it("clamps an oversized explicit range to 400 lines", async () => {
    const { ctx } = memorySandbox({ "/repo/big": numbered(1000) });
    const res = await run(readFileTool, { path: "big", startLine: 101, endLine: 900 }, ctx);
    expect(res.output).toContain("(lines 101-500 of 1000)");
    expect(res.output).toContain("Use startLine=501");
  });

  it("allows reading the last line", async () => {
    const { ctx } = memorySandbox({ "/repo/f": numbered(3) });
    const res = await run(readFileTool, { path: "f", startLine: 3 }, ctx);
    expect(res.output).toBe("/repo/f (lines 3-3 of 3)\n3\tline 3");
  });

  it("errors when startLine is past the end", async () => {
    const { ctx } = memorySandbox({ "/repo/f": numbered(3) });
    const res = await run(readFileTool, { path: "f", startLine: 4 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("has 3 lines");
  });

  it("errors when endLine is before startLine", async () => {
    const { ctx } = memorySandbox({ "/repo/f": numbered(5) });
    const res = await run(readFileTool, { path: "f", startLine: 4, endLine: 2 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("before startLine");
  });

  it("reports empty and binary files", async () => {
    const { ctx } = memorySandbox({ "/repo/empty": "", "/repo/bin": "ab\0cd" });
    expect((await run(readFileTool, { path: "empty" }, ctx)).output).toBe("/repo/empty is empty.");
    const bin = await run(readFileTool, { path: "bin" }, ctx);
    expect(bin.isError).toBe(true);
    expect(bin.output).toContain("binary");
  });

  it("returns an error result for a missing file", async () => {
    const { ctx } = memorySandbox();
    const res = await run(readFileTool, { path: "nope.txt" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No such file");
  });

  it("blocks paths outside /repo before touching the sandbox", async () => {
    const { ctx } = memorySandbox({ "/etc/passwd": "root" });
    for (const path of ["/etc/passwd", "../etc/passwd", "a/../../etc/passwd"]) {
      const res = await run(readFileTool, { path }, ctx);
      expect(res.isError, path).toBe(true);
      expect(res.output, path).toContain("outside /repo");
    }
  });

  it("rejects zero or negative line numbers", async () => {
    const { ctx } = memorySandbox({ "/repo/f": "x\n" });
    expect((await run(readFileTool, { path: "f", startLine: 0 }, ctx)).isError).toBe(true);
    expect((await run(readFileTool, { path: "f", endLine: -1 }, ctx)).isError).toBe(true);
  });
});

describe("edit_file", () => {
  it("replaces a unique match and reports the line", async () => {
    const { ctx, files } = memorySandbox({ "/repo/a.ts": "one\ntwo\nthree\n" });
    const res = await run(editFileTool, { path: "a.ts", oldText: "two", newText: "2" }, ctx);
    expect(res).toEqual({
      output: "Edited /repo/a.ts: replaced 1 occurrence starting at line 2.",
      isError: false,
    });
    expect(files.get("/repo/a.ts")).toBe("one\n2\nthree\n");
  });

  it("replaces a multi-line block", async () => {
    const { ctx, files } = memorySandbox({ "/repo/a": "a\nb\nc\nd\n" });
    await run(editFileTool, { path: "a", oldText: "b\nc", newText: "X" }, ctx);
    expect(files.get("/repo/a")).toBe("a\nX\nd\n");
  });

  it("fails with 0 matches, says so, and writes nothing", async () => {
    const { ctx, files, writes } = memorySandbox({ "/repo/a": "hello\n" });
    const res = await run(editFileTool, { path: "a", oldText: "nope", newText: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("0 matches");
    expect(writes).toEqual([]);
    expect(files.get("/repo/a")).toBe("hello\n");
  });

  it("fails with 2+ matches, reports how many, and writes nothing", async () => {
    const { ctx, writes } = memorySandbox({ "/repo/a": "x = 1\nx = 1\nx = 1\n" });
    const res = await run(editFileTool, { path: "a", oldText: "x = 1", newText: "x = 2" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("matches 3 places");
    expect(writes).toEqual([]);
  });

  it("counts overlapping matches as separate places, since the edit would be ambiguous", async () => {
    const { ctx, writes } = memorySandbox({ "/repo/a": "aaa\n" });
    const res = await run(editFileTool, { path: "a", oldText: "aa", newText: "b" }, ctx);
    // "aa" starts at index 0 and at index 1: replacing either gives a different file.
    expect(res.isError).toBe(true);
    expect(res.output).toContain("matches 2 places");
    expect(writes).toEqual([]);
  });

  it("treats $ patterns in newText literally", async () => {
    const { ctx, files } = memorySandbox({ "/repo/a": "price: X\n" });
    await run(editFileTool, { path: "a", oldText: "X", newText: "$& and $1 and $$" }, ctx);
    expect(files.get("/repo/a")).toBe("price: $& and $1 and $$\n");
  });

  it("hints about Windows line endings when the file has CRLF", async () => {
    const { ctx } = memorySandbox({ "/repo/a": "one\r\ntwo\r\n" });
    const res = await run(editFileTool, { path: "a", oldText: "one\ntwo", newText: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Windows line endings");
  });

  it("rejects an edit that changes nothing", async () => {
    const { ctx, writes } = memorySandbox({ "/repo/a": "x\n" });
    const res = await run(editFileTool, { path: "a", oldText: "x", newText: "x" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("identical");
    expect(writes).toEqual([]);
  });

  it("creates a new file when oldText is empty and the path does not exist", async () => {
    const { ctx, files } = memorySandbox();
    const res = await run(
      editFileTool,
      { path: "src/new.ts", oldText: "", newText: "export {};\n" },
      ctx,
    );
    expect(res).toEqual({ output: "Created /repo/src/new.ts.", isError: false });
    expect(files.get("/repo/src/new.ts")).toBe("export {};\n");
  });

  it("refuses to overwrite an existing file via empty oldText", async () => {
    const { ctx, files } = memorySandbox({ "/repo/a": "keep me\n" });
    const res = await run(editFileTool, { path: "a", oldText: "", newText: "gone" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("already exists");
    expect(files.get("/repo/a")).toBe("keep me\n");
  });

  it("checks existence correctly for paths with quotes and spaces", async () => {
    const { ctx, files } = memorySandbox({ "/repo/it's a file.txt": "x" });
    const exists = await run(
      editFileTool,
      { path: "it's a file.txt", oldText: "", newText: "y" },
      ctx,
    );
    expect(exists.isError).toBe(true);
    const created = await run(
      editFileTool,
      { path: "it's new.txt", oldText: "", newText: "y" },
      ctx,
    );
    expect(created.isError).toBe(false);
    expect(files.get("/repo/it's new.txt")).toBe("y");
  });

  it("errors on a missing file when oldText is given", async () => {
    const { ctx } = memorySandbox();
    const res = await run(editFileTool, { path: "missing.ts", oldText: "a", newText: "b" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toContain("No such file");
  });

  it("blocks paths outside /repo for both edit and create", async () => {
    const { ctx, writes } = memorySandbox({ "/etc/hosts": "127.0.0.1\n" });
    const edit = await run(
      editFileTool,
      { path: "/etc/hosts", oldText: "127", newText: "128" },
      ctx,
    );
    const create = await run(editFileTool, { path: "../x", oldText: "", newText: "y" }, ctx);
    expect(edit.isError && create.isError).toBe(true);
    expect(edit.output).toContain("outside /repo");
    expect(writes).toEqual([]);
  });

  it("rejects missing or non-string fields", async () => {
    const { ctx } = memorySandbox({ "/repo/a": "x" });
    expect((await run(editFileTool, { path: "a", oldText: "x" }, ctx)).isError).toBe(true);
    expect((await run(editFileTool, { path: "a", oldText: 1, newText: "y" }, ctx)).isError).toBe(
      true,
    );
  });
});
