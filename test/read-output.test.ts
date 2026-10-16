import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Sandbox } from "../src/sandbox/types.js";
import { FileOutputStore, makeReadOutputTool } from "../src/tools/read-output.js";
import { runTool } from "../src/tools/schema.js";

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
const ctx = { sandbox, step: 9 };

describe("FileOutputStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iaso-out-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saves and loads per step and call, creating the folder", async () => {
    const store = new FileOutputStore(join(dir, "runs", "r1", "outputs"));
    await store.save(7, 1, "first");
    await store.save(7, 2, "second");
    expect(await store.load(7, 1)).toBe("first");
    expect(await store.load(7, 2)).toBe("second");
  });

  it("returns undefined for something never saved", async () => {
    expect(await new FileOutputStore(join(dir, "none")).load(1, 1)).toBeUndefined();
  });
});

describe("read_output tool", () => {
  let dir: string;
  let store: FileOutputStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iaso-out-"));
    store = new FileOutputStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const tool = () => makeReadOutputTool(store);

  it("returns numbered lines with a header; call defaults to 1", async () => {
    await store.save(4, 1, "alpha\nbeta\n");
    const res = await runTool(tool(), { step: 4 }, ctx);
    expect(res).toEqual({
      output: "step 4, call 1 (lines 1-2 of 2)\n1\talpha\n2\tbeta",
      isError: false,
    });
  });

  it("reads a range and says how to continue", async () => {
    await store.save(4, 2, Array.from({ length: 1000 }, (_, i) => `l${String(i + 1)}`).join("\n"));
    const res = await runTool(tool(), { step: 4, call: 2, startLine: 10, endLine: 12 }, ctx);
    expect(res.output).toContain("(lines 10-12 of 1000)");
    expect(res.output).toContain("12\tl12");
    const wide = await runTool(tool(), { step: 4, call: 2 }, ctx);
    expect(wide.output).toContain("[600 more lines. Use startLine=401 to continue.]");
  });

  it("errors clearly for an unknown step, a start past the end, and bad ranges", async () => {
    await store.save(1, 1, "one\ntwo");
    const missing = await runTool(tool(), { step: 99 }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain("No saved output for step 99, call 1");
    expect((await runTool(tool(), { step: 1, startLine: 5 }, ctx)).isError).toBe(true);
    expect((await runTool(tool(), { step: 1, startLine: 2, endLine: 1 }, ctx)).isError).toBe(true);
    expect((await runTool(tool(), { step: 0 }, ctx)).isError).toBe(true);
  });
});
