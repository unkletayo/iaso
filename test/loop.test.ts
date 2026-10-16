import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "../src/agent/budget.js";
import { type LoopOptions, runLoop } from "../src/agent/loop.js";
import { NOTES_NUDGE, NO_TOOL_NUDGE, PROMPT_VERSION } from "../src/agent/prompts.js";
import { BUDGET_DEFAULTS } from "../src/config.js";
import { computeCost } from "../src/telemetry/cost.js";
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

/** All text of the first (context) message of a request. */
const contextText = (req: ChatRequest | undefined): string =>
  textsOf(req?.messages[0]?.content ?? []).join("\n\n");
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
    const text = contextText(s.provider.requests[1]);
    expect(text).toContain("## Files you edited");
    expect(text).toContain("const x = fixed;");
    expect(contextText(s.provider.requests[0])).not.toContain("Files you edited");
  });

  it("does not add a file to the working set when the edit failed", async () => {
    const edit = mockToolCall("e", "edit_file", { path: "a.js", oldText: "nope", newText: "x" });
    const s = setup([edit, submitCall()], {}, { "/repo/a.js": "abc" });
    await s.run();
    expect(contextText(s.provider.requests[1])).not.toContain("Files you edited");
  });

  it("keeps notes between steps and shows them to the model", async () => {
    const notes = mockToolCall("n", "notes", {
      phase: "fix",
      failedApproaches: [{ what: "use <=", whyItFailed: "off by two" }],
    });
    const s = setup([notes, submitCall()]);
    const res = await s.run();
    expect(res.state.phase).toBe("fix");
    expect(contextText(s.provider.requests[1])).toContain("- use <= (failed because: off by two)");
  });
});

describe("runLoop: nudges", () => {
  it("nudges to update notes after 8 steps without notes, and not on every step after", async () => {
    const script = [
      ...Array.from({ length: 10 }, (_, i) => bashCall(`c${String(i)}`, `echo ${String(i)}`)),
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
      ...Array.from({ length: 9 }, (_, i) => bashCall(`c${String(i)}`, `echo ${String(i)}`)),
      mockToolCall("n", "notes", { todo: ["x"] }),
      ...Array.from({ length: 6 }, (_, i) => bashCall(`d${String(i)}`, `echo d${String(i)}`)),
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

describe("runLoop: loop detection", () => {
  const sameBash = (n: number) =>
    Array.from({ length: n }, (_, i) => bashCall(`c${String(i)}`, "cat a.txt"));
  const nudgeTexts = (provider: MockProvider): string[] =>
    provider.requests.flatMap((r) =>
      textsOf(lastUser(r)).filter((t) => t.includes("You repeated this")),
    );

  it("nudges on the third identical command and tells the model what repeated", async () => {
    const s = setup([...sameBash(3), submitCall()]);
    const res = await s.run();
    expect(res.status).toBe("submitted");
    const nudges = nudgeTexts(s.provider);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toContain("cat a.txt");
    expect(nudges[0]).toContain("failedApproaches");
  });

  it("ends the run as stuck on the repeat after two nudges, and still returns the diff", async () => {
    const s = setup([...sameBash(6), submitCall()]);
    const res = await s.run();
    expect(res.status).toBe("stuck");
    expect(res.steps).toBe(5);
    expect(res.message).toContain("2 warnings");
    expect(res.diff).toBe("DIFF");
    expect(nudgeTexts(s.provider)).toHaveLength(2);
  });

  it("logs the step that ended the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iaso-stuck-"));
    const trajectory = new TrajectoryWriter(join(dir, "t.jsonl"));
    const s = setup([...sameBash(6)], { trajectory });
    await s.run();
    expect(await readTrajectory(trajectory.path)).toHaveLength(5);
  });

  it("does not flag a repeated command that has an edit in between", async () => {
    const edit = (id: string, oldText: string, newText: string) =>
      mockToolCall(id, "edit_file", { path: "a.txt", oldText, newText });
    const s = setup(
      [
        bashCall("c1", "cat a.txt"),
        edit("e1", "one", "two"),
        bashCall("c2", "cat a.txt"),
        edit("e2", "two", "three"),
        bashCall("c3", "cat a.txt"),
        submitCall(),
      ],
      {},
      { "/repo/a.txt": "one" },
    );
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(nudgeTexts(s.provider)).toHaveLength(0);
  });

  it("nudges once per step even when two calls repeat together", async () => {
    const second = (i: number): ContentBlock => ({
      type: "tool_call",
      id: `b${String(i)}`,
      name: "bash",
      input: { cmd: "cat b.txt" },
    });
    const step = (i: number) =>
      mockToolCall(`a${String(i)}`, "bash", { cmd: "cat a.txt" }, [second(i)]);
    const s = setup([step(1), step(2), step(3), submitCall()]);
    await s.run();
    expect(nudgeTexts(s.provider)).toHaveLength(1);
  });
});

describe("runLoop: compaction", () => {
  const compactorPrices = { inputPrice: 1, outputPrice: 5, cachedInputPrice: 0.1 };
  const summary = {
    learned: ["range stops one short"],
    files: [{ path: "src/range.js", why: "the bug" }],
    tests: [],
    failedApproaches: [{ what: "swap args", whyItFailed: "wrong side" }],
  };
  const withTokens = (step: ScriptedStep, inputTokens: number): ScriptedStep => ({
    ...(step as ChatResponse),
    usage: { inputTokens, outputTokens: 5, cachedInputTokens: 0 },
  });
  /** Cheap steps, except steps `5 .. bigUntil - 1`, which report a context of `big` tokens. */
  const growing = (big: number, count: number, bigUntil = 6): ScriptedStep[] =>
    Array.from({ length: count }, (_, i) =>
      withTokens(
        bashCall(`c${String(i)}`, `echo ${String(i)}`),
        i >= 5 && i < bigUntil ? big : 100,
      ),
    );
  const compactor = (script: ScriptedStep[]) => ({
    provider: new MockProvider(script),
    prices: compactorPrices,
  });

  it("folds old steps into a summary at 50% of the window and logs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iaso-compact-"));
    try {
      const c = compactor([mockToolCall("k", "record_summary", summary)]);
      const s = setup([...growing(1200, 7), submitCall()], {
        contextWindow: 2000,
        compaction: c,
        trajectory: new TrajectoryWriter(join(dir, "t.jsonl")),
      });
      const res = await s.run();
      expect(res.status).toBe("submitted");
      expect(res.compactions).toBe(1);
      expect(c.provider.requests).toHaveLength(1);

      const after = s.provider.requests[6];
      expect(contextText(after)).toContain("## Summary of earlier steps");
      expect(contextText(after)).toContain("range stops one short");
      expect(after?.messages.length).toBeLessThan(s.provider.requests[5]?.messages.length ?? 0);
      expect(res.state.confirmedFacts).toEqual([expect.stringContaining("range stops one short")]);

      const steps = await readTrajectory(join(dir, "t.jsonl"));
      const events = steps.flatMap((x) => x.contextEvents ?? []);
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe("compact");
      expect(events[0]?.firstStep).toBeGreaterThan(1);
      expect(events[0]?.summary).toContain("range stops one short");
      expect(steps[6]?.contextEvents).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adds the compactor's cost to the result and the budget check", async () => {
    const c = compactor([mockToolCall("k", "record_summary", summary)]);
    const script = [...growing(1200, 7), submitCall()];
    const s = setup(script, { contextWindow: 2000, compaction: c });
    const res = await s.run();
    const main = script.reduce(
      (sum, step) => sum + computeCost((step as ChatResponse).usage, prices),
      0,
    );
    const compacting = computeCost(
      { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      compactorPrices,
    );
    expect(res.costUsd).toBeCloseTo(main + compacting, 10);
    expect(res.usage.inputTokens).toBe(
      script.reduce((n, step) => n + (step as ChatResponse).usage.inputTokens, 0) + 10,
    );
  });

  it("carries on when the compactor fails, and does not retry at once", async () => {
    const c = compactor([mockText("no"), mockText("no")]);
    const s = setup([...growing(1200, 9, 9), submitCall()], { contextWindow: 2000, compaction: c });
    const res = await s.run();
    expect(res.status).toBe("submitted");
    expect(res.compactions).toBe(0);
    expect(c.provider.requests).toHaveLength(2);
  });

  it("drops the summary, then old steps, at 85% of the window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iaso-hard-"));
    try {
      const s = setup([...growing(1800, 9, 9), submitCall()], {
        contextWindow: 2000,
        trajectory: new TrajectoryWriter(join(dir, "t.jsonl")),
      });
      const res = await s.run();
      expect(res.status).toBe("submitted");
      const events = (await readTrajectory(join(dir, "t.jsonl"))).flatMap(
        (x) => x.contextEvents ?? [],
      );
      expect(events.some((e) => e.kind === "trim_history")).toBe(true);
      const last = s.provider.requests.at(-1);
      expect(last?.messages.length).toBeLessThanOrEqual(1 + 4 * 2 + 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without a context window", async () => {
    const s = setup([...growing(10_000, 7, 7), submitCall()]);
    const res = await s.run();
    expect(res.compactions).toBe(0);
    expect(s.provider.requests.at(-1)?.messages).toHaveLength(1 + 7 * 2);
  });
});
