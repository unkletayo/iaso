import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BUDGET_DEFAULTS } from "../src/config.js";
import { MockProvider, mockText, mockToolCall } from "../src/providers/mock.js";
import { type SessionEvent, type SessionOptions, createSession } from "../src/core/session.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

const prices = { inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3 };
const plan = {
  rootCauseHypothesis: "off by one",
  filesToChange: [{ path: "a.js", change: "x" }],
  testPlan: "t",
  risks: [],
  steps: ["s"],
};
const submit = mockToolCall("s", "submit", {
  summary: "done",
  prTitle: "Fix it",
  prSummary: "Fixes it.",
  testsAdded: [],
  confidence: "high",
});

let runDir = "";
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "iaso-session-"));
});

function setup(
  script: ConstructorParameters<typeof MockProvider>[0],
  over: Partial<SessionOptions> = {},
) {
  const provider = new MockProvider(script);
  const fake = fakeSandbox();
  const options: SessionOptions = {
    fix: { provider, prices },
    sandbox: fake.sandbox,
    issue: "ISSUE",
    limits: BUDGET_DEFAULTS,
    runDir,
    usePlan: false,
    approvalPolicy: { default: "auto", rules: [] },
    ...over,
  };
  return { provider, options };
}

async function collectEvents(session: ReturnType<typeof createSession>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const startPromise = session.start();
  for await (const event of session.events) {
    events.push(event);
  }
  await startPromise;
  return events;
}

describe("event sequence", () => {
  it("emits step_started, text_delta, tool_call, tool_result, finished for auto policy", async () => {
    const { options } = setup([mockText("thinking..."), submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("step_started");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds[kinds.length - 1]).toBe("finished");
  });

  it("step_started precedes tool_call in the same step", async () => {
    const { options } = setup([submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    const stepStarted = events.findIndex((e) => e.kind === "step_started");
    const toolCall = events.findIndex((e) => e.kind === "tool_call");
    expect(stepStarted).toBeLessThan(toolCall);
  });

  it("tool_call precedes tool_result", async () => {
    const { options } = setup([submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    const toolCall = events.findIndex((e) => e.kind === "tool_call");
    const toolResult = events.findIndex((e) => e.kind === "tool_result");
    expect(toolCall).toBeLessThan(toolResult);
  });

  it("finished carries the pipeline result", async () => {
    const { options } = setup([submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).toBe("submitted");
      expect(finished.verification.submitted).toBe(true);
      expect(finished.network).toBe("enabled");
    }
  });

  it("text_delta carries the model's text output", async () => {
    const { options } = setup([mockText("my reasoning"), submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    const delta = events.find((e) => e.kind === "text_delta");
    expect(delta?.kind).toBe("text_delta");
    if (delta?.kind === "text_delta") {
      expect(delta.delta).toBe("my reasoning");
    }
  });
});

describe("approval flow", () => {
  it("auto policy never emits approval_requested", async () => {
    const { options } = setup([submit]);
    const session = createSession(options);
    const events = await collectEvents(session);

    expect(events.some((e) => e.kind === "approval_requested")).toBe(false);
  });

  it("ask policy emits approval_requested and blocks until approved", async () => {
    const { options } = setup([submit], { approvalPolicy: { default: "ask", rules: [] } });
    const session = createSession(options);
    const events: SessionEvent[] = [];
    const startPromise = session.start();

    // Drive events until we see approval_requested, then approve
    for await (const event of session.events) {
      events.push(event);
      if (event.kind === "approval_requested") {
        session.send({ kind: "approve", id: event.id });
      }
      if (event.kind === "finished") break;
    }
    await startPromise;

    expect(events.some((e) => e.kind === "approval_requested")).toBe(true);
    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).toBe("submitted");
    }
  });

  it("ask policy with reject makes tool return an error result", async () => {
    const { options } = setup(
      // After the submit is rejected the agent calls submit again (second element)
      [submit, submit],
      { approvalPolicy: { default: "ask", rules: [] } },
    );
    const session = createSession(options);
    const events: SessionEvent[] = [];
    const startPromise = session.start();

    let rejectedOnce = false;
    for await (const event of session.events) {
      events.push(event);
      if (event.kind === "approval_requested") {
        if (!rejectedOnce) {
          rejectedOnce = true;
          session.send({ kind: "reject", id: event.id, reason: "not ready" });
        } else {
          session.send({ kind: "approve", id: event.id });
        }
      }
      if (event.kind === "finished") break;
    }
    await startPromise;

    // The first tool result should be an error (rejected)
    const firstResult = events.find((e) => e.kind === "tool_result");
    expect(firstResult?.kind).toBe("tool_result");
    if (firstResult?.kind === "tool_result") {
      expect(firstResult.error).toBe(true);
    }
  });

  it("deny policy blocks all tool calls", async () => {
    const { options } = setup(
      // With all tools denied, the loop will end with no_tool_use or error after nudges
      [submit, submit, submit],
      { approvalPolicy: { default: "deny", rules: [] } },
    );
    const session = createSession(options);
    const events = await collectEvents(session);

    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).not.toBe("submitted");
      expect(finished.verification.submitted).toBe(false);
    }
  });
});

describe("cancel", () => {
  it("cancel during ask policy resolves all pending approvals as deny", async () => {
    const { options } = setup([submit], { approvalPolicy: { default: "ask", rules: [] } });
    const session = createSession(options);
    const events: SessionEvent[] = [];
    const startPromise = session.start();

    for await (const event of session.events) {
      events.push(event);
      if (event.kind === "approval_requested") {
        session.send({ kind: "cancel" });
      }
      if (event.kind === "finished") break;
    }
    await startPromise;

    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).not.toBe("submitted");
    }
  });
});

describe("policy matching", () => {
  it("rule overrides default: auto default with one deny rule blocks that tool", async () => {
    const { options } = setup(
      // submit is blocked by rule, then the loop runs out of tool uses
      [submit, submit, submit],
      {
        approvalPolicy: {
          default: "auto",
          rules: [{ tool: "submit", action: "deny" }],
        },
      },
    );
    const session = createSession(options);
    const events = await collectEvents(session);

    const finished = events.find((e) => e.kind === "finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).not.toBe("submitted");
    }
    // No approval_requested because deny skips the ask step
    expect(events.some((e) => e.kind === "approval_requested")).toBe(false);
  });

  it("rule overrides default: deny default with one auto rule allows that tool", async () => {
    const { options } = setup([submit], {
      approvalPolicy: {
        default: "deny",
        rules: [{ tool: "submit", action: "auto" }],
      },
    });
    const session = createSession(options);
    const events = await collectEvents(session);

    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).toBe("submitted");
    }
  });

  it("first matching rule wins", async () => {
    const { options } = setup([submit], {
      approvalPolicy: {
        default: "deny",
        rules: [
          { tool: "submit", action: "auto" },
          { tool: "submit", action: "deny" },
        ],
      },
    });
    const session = createSession(options);
    const events = await collectEvents(session);

    const finished = events.find((e) => e.kind === "finished");
    if (finished?.kind === "finished") {
      expect(finished.result.status).toBe("submitted");
    }
  });
});
