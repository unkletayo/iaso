import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, beforeEach } from "vitest";
import {
  type AwaitRequest,
  type ServeCommandOptions,
  type ServeControl,
  type ServeEvent,
  type ServeDeps,
  type ServePart,
  executeServeCommand,
  translateEvent,
} from "../src/commands/serve.js";
import { MockProvider, mockText, mockToolCall } from "../src/providers/mock.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";
import { BUDGET_DEFAULTS } from "../src/config.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const submit = mockToolCall("s", "submit", {
  summary: "done",
  prTitle: "Fix it",
  prSummary: "Fixes it.",
  testsAdded: [],
  confidence: "high",
});

type AwaitHandler = (a: AwaitRequest) => ServeControl;

/** Deps where stdout is intercepted: awaiting events trigger the handler, which pushes a reply to stdin. */
function setup(
  script: ConstructorParameters<typeof MockProvider>[0],
  onAwaiting: AwaitHandler = (a) => ({ kind: "approve", id: a.id }),
) {
  const provider = new MockProvider(script);
  const fake = fakeSandbox();

  const stdinThrough = new PassThrough();
  const collected: ServeEvent[] = [];

  const stdout = new Writable({
    write(chunk: Buffer, _enc, cb) {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ServeEvent;
          collected.push(event);
          if (event.type === "run.awaiting") {
            const ctrl = onAwaiting(event.await);
            stdinThrough.push(`${JSON.stringify(ctrl)}\n`);
          }
        } catch {
          /* skip malformed */
        }
      }
      cb();
    },
  });

  const deps: ServeDeps = {
    checkClaim: () => Promise.resolve({ blockers: [], warnings: [] }),
    resolveSource: () =>
      Promise.resolve({
        repoPath: runDir,
        issue: "ISSUE",
        label: "local",
        cleanup: async () => {},
      }),
    createProvider: () => provider,
    createSandbox: () => fake.sandbox,
    log: () => {},
    stdin: stdinThrough,
    stdout,
  };
  const opts: ServeCommandOptions = {
    repo: runDir,
    issue: join(runDir, "issue.md"),
    model: "anthropic:claude-haiku-5-5",
    plan: false,
    maxSteps: BUDGET_DEFAULTS.maxSteps,
    maxCost: BUDGET_DEFAULTS.maxCostUsd,
    maxTime: BUDGET_DEFAULTS.maxTimeMinutes,
    runs: runDir,
    stdio: true,
  };
  return { provider, deps, opts, events: collected };
}

let runDir = "";
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "iaso-serve-"));
});

// ── translateEvent unit tests ─────────────────────────────────────────────────

describe("translateEvent", () => {
  const runId = "test-run";

  it("maps first step_started to run.in-progress, subsequent to null", () => {
    const seen = { value: false };
    expect(translateEvent(runId, { kind: "step_started", step: 1 }, seen)).toMatchObject({
      type: "run.in-progress",
    });
    expect(translateEvent(runId, { kind: "step_started", step: 2 }, seen)).toBeNull();
  });

  it("maps text_delta to message.part kind:text", () => {
    const seen = { value: false };
    expect(translateEvent(runId, { kind: "text_delta", step: 1, delta: "hi" }, seen)).toMatchObject(
      { type: "message.part", part: { kind: "text", delta: "hi" } },
    );
  });

  it("maps tool_call to message.part kind:tool_call", () => {
    const seen = { value: false };
    expect(
      translateEvent(runId, { kind: "tool_call", step: 1, id: "x", name: "bash", input: {} }, seen),
    ).toMatchObject({ type: "message.part", part: { kind: "tool_call", name: "bash" } });
  });

  it("maps approval_requested to run.awaiting", () => {
    const seen = { value: false };
    expect(
      translateEvent(
        runId,
        { kind: "approval_requested", step: 1, id: "x", name: "bash", input: {} },
        seen,
      ),
    ).toMatchObject({ type: "run.awaiting", status: "awaiting", await: { id: "x", name: "bash" } });
  });

  it("maps finished:submitted to run.completed", () => {
    const seen = { value: false };
    const result = {
      status: "submitted" as const,
      planCostUsd: 0,
      planSteps: 0,
      costUsd: 0,
      steps: 1,
      diff: "",
    };
    expect(
      translateEvent(
        runId,
        {
          kind: "finished",
          result,
          verification: { submitted: true, phase: "report" },
          network: "enabled",
        },
        seen,
      ),
    ).toMatchObject({ type: "run.completed" });
  });

  it("maps finished:cancelled to run.cancelled", () => {
    const seen = { value: false };
    const result = {
      status: "cancelled" as const,
      planCostUsd: 0,
      planSteps: 0,
      costUsd: 0,
      steps: 1,
      diff: "",
    };
    expect(
      translateEvent(
        runId,
        {
          kind: "finished",
          result,
          verification: { submitted: false, phase: "fix" },
          network: "enabled",
        },
        seen,
      ),
    ).toMatchObject({ type: "run.cancelled" });
  });

  it("maps finished:budget_exceeded to run.failed with message", () => {
    const seen = { value: false };
    const result = {
      status: "budget_exceeded" as const,
      message: "over budget",
      planCostUsd: 0,
      planSteps: 0,
      costUsd: 0,
      steps: 1,
      diff: "",
    };
    expect(
      translateEvent(
        runId,
        {
          kind: "finished",
          result,
          verification: { submitted: false, phase: "fix" },
          network: "enabled",
        },
        seen,
      ),
    ).toMatchObject({ type: "run.failed", message: "over budget" });
  });
});

// ── integration: event sequence ───────────────────────────────────────────────

describe("executeServeCommand event sequence", () => {
  it("emits run.created then run.in-progress then run.completed", async () => {
    const { deps, opts, events } = setup([submit]);
    await executeServeCommand(opts, deps);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.created");
    expect(types).toContain("run.in-progress");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("emits run.awaiting before run.completed", async () => {
    const { deps, opts, events } = setup([submit]);
    await executeServeCommand(opts, deps);
    const types = events.map((e) => e.type);
    const awaitIdx = types.indexOf("run.awaiting");
    const completedIdx = types.indexOf("run.completed");
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeLessThan(completedIdx);
  });

  it("includes text_delta part when model responds with text", async () => {
    const { deps, opts, events } = setup([mockText("thinking..."), submit]);
    await executeServeCommand(opts, deps);
    type TextPart = Extract<ServeEvent, { type: "message.part" }> & {
      part: Extract<ServePart, { kind: "text" }>;
    };
    const textParts = events.filter(
      (e): e is TextPart => e.type === "message.part" && e.part.kind === "text",
    );
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0]?.part.delta).toBe("thinking...");
  });

  it("all events carry the same run_id", async () => {
    const { deps, opts, events } = setup([submit]);
    await executeServeCommand(opts, deps);
    const ids = new Set(events.map((e) => e.run_id));
    expect(ids.size).toBe(1);
  });

  it("emits run.cancelled when cancel is sent in response to awaiting", async () => {
    const { deps, opts, events } = setup([submit], (_) => ({ kind: "cancel" }));
    await executeServeCommand(opts, deps);
    const last = events.at(-1);
    expect(last?.type).toBe("run.cancelled");
  });

  it("rejected tool call produces an error tool_result, then run.failed after script exhausted", async () => {
    const { deps, opts, events } = setup([submit, submit, submit], (a) => {
      return { kind: "reject", id: a.id };
    });
    await executeServeCommand(opts, deps);
    // All awaiting events should have a matching tool_result with error
    const awaitingIds = events
      .filter((e): e is Extract<ServeEvent, { type: "run.awaiting" }> => e.type === "run.awaiting")
      .map((e) => e.await.id);
    for (const id of awaitingIds) {
      type ToolResultPart = Extract<ServeEvent, { type: "message.part" }> & {
        part: Extract<ServePart, { kind: "tool_result" }>;
      };
      const result = events.find(
        (e): e is ToolResultPart =>
          e.type === "message.part" && e.part.kind === "tool_result" && e.part.id === id,
      );
      expect(result?.part.error).toBe(true);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("run.failed");
  });
});
