import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Sandbox } from "../src/sandbox/types.js";
import {
  type Tool,
  type ToolContext,
  defineTool,
  parseToolInput,
  runTool,
  toToolDef,
} from "../src/tools/schema.js";

const echo = defineTool({
  name: "echo",
  description: "Echo text back.",
  input: z.strictObject({
    text: z.string(),
    times: z.number().int().min(1).max(5).optional(),
  }),
});

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
const ctx: ToolContext = { sandbox, step: 1 };

function makeEchoTool(run: Tool<typeof echo.input>["run"]): Tool {
  return { definition: echo, run };
}

describe("toToolDef", () => {
  it("produces a neutral ToolDef with JSON Schema and no $schema key", () => {
    const def = toToolDef(echo);
    expect(def.name).toBe("echo");
    expect(def.description).toBe("Echo text back.");
    expect(def.inputSchema).not.toHaveProperty("$schema");
    expect(def.inputSchema).toMatchObject({
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        times: { type: "integer", minimum: 1, maximum: 5 },
      },
    });
  });
});

describe("parseToolInput", () => {
  it("accepts valid input", () => {
    expect(parseToolInput(echo, { text: "hi" })).toEqual({ ok: true, value: { text: "hi" } });
  });

  it("reports readable errors for wrong types, missing fields and unknown keys", () => {
    for (const bad of [{ text: 1 }, {}, { text: "a", extra: true }, { text: "a", times: 9 }]) {
      const res = parseToolInput(echo, bad);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.length).toBeGreaterThan(0);
    }
  });

  it("explains when the input was raw, unparseable text", () => {
    const res = parseToolInput(echo, "{oops");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not valid JSON/);
  });
});

describe("runTool", () => {
  it("runs a valid call and returns its result", async () => {
    const tool = makeEchoTool(({ text }) => Promise.resolve({ output: text, isError: false }));
    expect(await runTool(tool, { text: "hi" }, ctx)).toEqual({ output: "hi", isError: false });
  });

  it("returns an error result, without running the tool, for invalid input", async () => {
    let ran = false;
    const tool = makeEchoTool(() => {
      ran = true;
      return Promise.resolve({ output: "", isError: false });
    });
    const res = await runTool(tool, { text: 5 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/^Invalid input for echo:/);
    expect(ran).toBe(false);
  });

  it("turns a thrown error into an error result instead of throwing", async () => {
    const tool = makeEchoTool(() => Promise.reject(new Error("disk on fire")));
    expect(await runTool(tool, { text: "x" }, ctx)).toEqual({
      output: "echo failed: disk on fire",
      isError: true,
    });
  });

  it("handles non-Error throws", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberately rejecting with a non-Error
    const tool = makeEchoTool(() => Promise.reject("plain string"));
    const res = await runTool(tool, { text: "x" }, ctx);
    expect(res).toEqual({ output: "echo failed: plain string", isError: true });
  });

  it("truncates long output", async () => {
    const tool = makeEchoTool(() =>
      Promise.resolve({ output: "z".repeat(20_000), isError: false }),
    );
    const res = await runTool(tool, { text: "x" }, ctx);
    expect(res.output.length).toBeLessThan(9_000);
    expect(res.output).toContain("characters cut");
  });

  it("keeps isError from the tool", async () => {
    const tool = makeEchoTool(() => Promise.resolve({ output: "nope", isError: true }));
    expect((await runTool(tool, { text: "x" }, ctx)).isError).toBe(true);
  });
});
