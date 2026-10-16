import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/agent/budget.js";
import { type LoopOptions, runLoop } from "../src/agent/loop.js";
import { NOTES_NUDGE, NO_TOOL_NUDGE, PROMPT_VERSION } from "../src/agent/prompts.js";
import { BUDGET_DEFAULTS } from "../src/config.js";
import type { ChatRequest, ChatResponse, ContentBlock } from "../src/providers/types.js";
import { MockProvider, type ScriptedStep, mockText, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";
import { readTrajectory, TrajectoryWriter } from "../src/telemetry/trajectory.js";
import { bashTool } from "../src/tools/bash.js";
import { editFileTool } from "../src/tools/edit-file.js";
import { notesTool } from "../src/tools/notes.js";
import { readFileTool } from "../src/tools/read-file.js";
import { FileOutputStore, makeReadOutputTool } from "../src/tools/read-output.js";
import { submitTool } from "../src/tools/submit.js";

const prices = { inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3 };
const submitCall = (id = "s") =>
  mockToolCall(id, "submit", { summary: "fixed", testsAdded: ["t.js"], confidence: "high" });
const bashCall = (id: string, cmd = "ls") => mockToolCall(id, "bash", { cmd });

function setup(
  script: ScriptedStep[],
  over: Partial<LoopOptions> = {},
  files: Record<string, string> = {},
) {
  const provider = new MockProvider(script);
  const fake = fakeSandbox(files);
  const options: LoopOptions = {
    provider,
    prices,
    sandbox: fake.sandbox,
    tools: [bashTool, readFileTool, editFileTool, notesTool, submitTool],
    systemPrompt: "SYS",
    issue: "ISSUE TEXT",
    budget: new Budget(BUDGET_DEFAULTS),
    ...over,
  };
  return { provider, fake, options, run: () => runLoop(options) };
}

const lastUser = (req: ChatRequest | undefined): ContentBlock[] =>
  req?.messages.at(-1)?.content ?? [];
const textsOf = (blocks: ContentBlock[]): string[] =>
  blocks.flatMap((b) => (b.type === "text" ? [b.text] : []));
const resultsOf = (blocks: ContentBlock[]) =>
  blocks.flatMap((b) => (b.type === "tool_result" ? [b] : []));

describe("runLoop: ending", () => {
  it("runs a tool, feeds the result back, and ends when submit is called", async () => {
    const s = setup([bashCall("c1", "echo hi"), submitCall()], {});
    vi.mocked(s.fake.exec).mockResolvedValue({
      exitCode: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    });
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(res.steps).toBe(2);
    expect(res.submission).toMatchObject({ summary: "fixed", confidence: "high", step: 2 });
    expect(res.diff).toBe("DIFF");
    const second = s.provider.requests[1];
    expect(second?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(resultsOf(lastUser(second))[0]?.output).toContain("hi");
    expect(s.provider.requests[0]?.system).toBe("SYS");
    expect(s.provider.requests[0]?.tools.map((t) => t.name)).toEqual([
      "bash",
      "read_file",
      "edit_file",
      "notes",
      "submit",
    ]);
  });

  it("nudges once when the model answers without a tool, then stops", async () => {
    const s = setup([mockText("done?"), mockText("still done")]);
    const res = await s.run();
    expect(res.status).toBe("no_tool_use");
    expect(res.steps).toBe(2);
    expect(textsOf(lastUser(s.provider.requests[1]))).toEqual([NO_TOOL_NUDGE]);
  });

  it("forgives one missed tool call: using a tool afterwards resets the nudge", async () => {
    const s = setup([mockText("hm"), bashCall("c1"), mockText("hm again"), submitCall()]);
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(res.steps).toBe(4);
  });

  it("stops at the step limit and returns the current diff", async () => {
    const script = Array.from({ length: 5 }, (_, i) => bashCall(`c${String(i)}`));
    const s = setup(script, { budget: new Budget({ ...BUDGET_DEFAULTS, maxSteps: 3 }) });
    const res = await s.run();
    expect(res.status).toBe("budget_exceeded");
    expect(res.message).toContain("step limit");
    expect(res.steps).toBe(3);
    expect(s.provider.callCount).toBe(3);
    expect(res.diff).toBe("DIFF");
  });

  it("stops at the cost limit", async () => {
    const expensive = { inputPrice: 1_000_000, outputPrice: 0, cachedInputPrice: 0 };
    const s = setup([bashCall("c1"), bashCall("c2")], { prices: expensive });
    const res = await s.run();
    expect(res.status).toBe("budget_exceeded");
    expect(res.message).toContain("cost limit");
    expect(res.steps).toBe(1);
    expect(res.costUsd).toBeCloseTo(10, 5);
  });

  it("stops at the time limit", async () => {
    const clock = { now: 0 };
    const budget = new Budget(BUDGET_DEFAULTS, () => clock.now);
    const s = setup(
      [
        () => {
          clock.now += 21 * 60_000;
          return bashCall("c1");
        },
        bashCall("c2"),
      ] as ScriptedStep[],
      { budget },
    );
    const res = await s.run();
    expect(res.status).toBe("budget_exceeded");
    expect(res.message).toContain("time limit");
  });

  it("reports a provider failure as status error and still returns the diff", async () => {
    const s = setup([]);
    const res = await s.run();
    expect(res.status).toBe("error");
    expect(res.message).toContain("script exhausted");
    expect(res.diff).toBe("DIFF");
  });

  it("treats a model-reported error stop as an error", async () => {
    const bad: ChatResponse = { ...mockText("x"), stopReason: "error" };
    const res = await setup([bad]).run();
    expect(res.status).toBe("error");
  });

  it("sums usage and cost over steps", async () => {
    const res = await setup([bashCall("c1"), submitCall()]).run();
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 0 });
    expect(res.costUsd).toBeCloseTo((20 * 3 + 10 * 15) / 1e6, 12);
  });
});

describe("runLoop: tools", () => {
  it("answers an unknown tool with an error result listing the real tools", async () => {
    const s = setup([mockToolCall("c1", "rm_rf", {}), submitCall()]);
    await s.run();
    const result = resultsOf(lastUser(s.provider.requests[1]))[0];
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain('Unknown tool "rm_rf"');
    expect(result?.output).toContain("bash, read_file");
  });

  it("returns several parallel calls in one message, in order, with matching ids", async () => {
    const both: ChatResponse = {
      content: [
        { type: "tool_call", id: "a", name: "bash", input: { cmd: "one" } },
        { type: "tool_call", id: "b", name: "bash", input: { cmd: "two" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
    const s = setup([both, submitCall()]);
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(resultsOf(lastUser(s.provider.requests[1])).map((r) => r.id)).toEqual(["a", "b"]);
    expect(vi.mocked(s.fake.exec).mock.calls.map((c) => c[0])).toEqual(["one", "two"]);
  });

  it("does not run calls that come after submit", async () => {
    const mixed: ChatResponse = {
      content: [
        {
          type: "tool_call",
          id: "s",
          name: "submit",
          input: { summary: "x", testsAdded: [], confidence: "low" },
        },
        { type: "tool_call", id: "b", name: "bash", input: { cmd: "rm -rf things" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    };
    const s = setup([mixed]);
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(s.fake.exec).not.toHaveBeenCalled();
  });

  it("puts an edited file's latest content in the next request's working set", async () => {
    const edit = mockToolCall("e", "edit_file", { path: "a.js", oldText: "bug", newText: "fixed" });
    const s = setup([edit, submitCall()], {}, { "/repo/a.js": "const x = bug;\n" });
    await s.run();
    const first = s.provider.requests[1]?.messages[0]?.content[0];
    const text = first?.type === "text" ? first.text : "";
    expect(text).toContain("## Files you edited");
    expect(text).toContain("const x = fixed;");
    const before = s.provider.requests[0]?.messages[0]?.content[0];
    expect(before?.type === "text" ? before.text : "").not.toContain("Files you edited");
  });

  it("does not add a file to the working set when the edit failed", async () => {
    const edit = mockToolCall("e", "edit_file", { path: "a.js", oldText: "nope", newText: "x" });
    const s = setup([edit, submitCall()], {}, { "/repo/a.js": "abc" });
    await s.run();
    const first = s.provider.requests[1]?.messages[0]?.content[0];
    expect(first?.type === "text" ? first.text : "").not.toContain("Files you edited");
  });

  it("keeps notes between steps and shows them to the model", async () => {
    const notes = mockToolCall("n", "notes", {
      phase: "fix",
      failedApproaches: [{ what: "use <=", whyItFailed: "off by two" }],
    });
    const s = setup([notes, submitCall()]);
    const res = await s.run();
    expect(res.state.phase).toBe("fix");
    const first = s.provider.requests[1]?.messages[0]?.content[0];
    expect(first?.type === "text" ? first.text : "").toContain(
      "- use <= (failed because: off by two)",
    );
  });
});

describe("runLoop: nudges", () => {
  it("nudges to update notes after 8 steps without notes, and not on every step after", async () => {
    const script = [
      ...Array.from({ length: 10 }, (_, i) => bashCall(`c${String(i)}`)),
      submitCall(),
    ];
    const s = setup(script);
    await s.run();
    const nudged = s.provider.requests.flatMap((r, i) =>
      textsOf(lastUser(r)).includes(NOTES_NUDGE) ? [i + 1] : [],
    );
    // The nudge rides on step 8's results, so the model sees it at request 9 only.
    expect(nudged).toEqual([9]);
  });

  it("does not nudge when notes are kept up to date", async () => {
    const script = [
      ...Array.from({ length: 9 }, (_, i) => bashCall(`c${String(i)}`)),
      mockToolCall("n", "notes", { todo: ["x"] }),
      ...Array.from({ length: 6 }, (_, i) => bashCall(`d${String(i)}`)),
      submitCall(),
    ];
    const s = setup(script);
    await s.run();
    // One nudge before the notes call at step 10; none in the 6 steps after it.
    const count = s.provider.requests.filter((r) =>
      textsOf(lastUser(r)).includes(NOTES_NUDGE),
    ).length;
    expect(count).toBe(1);
  });
});

describe("runLoop: long output, trajectory", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iaso-loop-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("shortens a huge result, saves the full text, and lets the model fetch it", async () => {
    const outputs = new FileOutputStore(join(dir, "outputs"));
    const big = Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1)}`).join("\n");
    const s = setup(
      [
        bashCall("c1", "cat big.txt"),
        mockToolCall("r", "read_output", { step: 1, startLine: 2500, endLine: 2501 }),
        submitCall(),
      ],
      { outputs, tools: [bashTool, notesTool, submitTool, makeReadOutputTool(outputs)] },
    );
    vi.mocked(s.fake.exec).mockResolvedValue({
      exitCode: 0,
      stdout: big,
      stderr: "",
      timedOut: false,
    });
    await s.run();
    const shown = resultsOf(lastUser(s.provider.requests[1]))[0]?.output ?? "";
    expect(shown.length).toBeLessThan(9000);
    expect(shown).toContain("[shortened. Full output: read_output with step=1, call=1]");
    expect(await outputs.load(1, 1)).toContain("line 3000");
    expect(resultsOf(lastUser(s.provider.requests[2]))[0]?.output).toContain("2500\tline");
  });

  it("shapes test output and points to the full copy", async () => {
    const outputs = new FileOutputStore(join(dir, "outputs"));
    const stdout = ["✔ one", "✔ two", "✖ three", "  AssertionError: nope", "ℹ fail 1"].join("\n");
    const s = setup([bashCall("c1", "npm test"), submitCall()], { outputs });
    vi.mocked(s.fake.exec).mockResolvedValue({
      exitCode: 1,
      stdout,
      stderr: "",
      timedOut: false,
    });
    await s.run();
    const shown = resultsOf(lastUser(s.provider.requests[1]))[0]?.output ?? "";
    expect(shown).not.toContain("✔ one");
    expect(shown).toContain("AssertionError: nope");
    expect(shown).toContain("read_output with step=1, call=1");
    expect(await outputs.load(1, 1)).toContain("✔ one");
  });

  it("leaves short, plain output alone and saves nothing", async () => {
    const outputs = new FileOutputStore(join(dir, "outputs"));
    const s = setup([bashCall("c1"), submitCall()], { outputs });
    await s.run();
    expect(await outputs.load(1, 1)).toBeUndefined();
    expect(resultsOf(lastUser(s.provider.requests[1]))[0]?.output).not.toContain("shortened");
  });

  it("writes one validated trajectory line per step with the prompt version", async () => {
    const path = join(dir, "runs", "r1", "trajectory.jsonl");
    const s = setup([bashCall("c1"), submitCall()], { trajectory: new TrajectoryWriter(path) });
    await s.run();
    const steps = await readTrajectory(path);
    expect(steps.map((x) => x.step)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({
      model: "mock:scripted",
      promptVersion: PROMPT_VERSION,
      phase: "plan",
    });
    expect(steps[0]?.toolCalls[0]?.name).toBe("bash");
    expect(steps[0]?.toolResults).toHaveLength(1);
    expect(steps[0]?.contextTokens).toBeGreaterThan(0);
    expect(steps[1]?.toolCalls[0]?.name).toBe("submit");
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("logs a step even when the model made no tool call", async () => {
    const path = join(dir, "t.jsonl");
    const s = setup([mockText("hmm"), mockText("hmm")], { trajectory: new TrajectoryWriter(path) });
    await s.run();
    const steps = await readTrajectory(path);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.response.text).toBe("hmm");
  });
});
