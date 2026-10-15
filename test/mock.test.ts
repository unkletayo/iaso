import { describe, expect, it } from "vitest";
import { MockProvider, mockText, mockToolCall } from "../src/providers/mock.js";
import type { ChatRequest } from "../src/providers/types.js";

const req: ChatRequest = {
  system: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  maxOutputTokens: 100,
};

describe("MockProvider", () => {
  it("replays scripted responses in order", async () => {
    const p = new MockProvider([mockToolCall("1", "bash", { cmd: "ls" }), mockText("done")]);
    const first = await p.chat(req);
    expect(first.stopReason).toBe("tool_use");
    expect(first.content[0]).toEqual({
      type: "tool_call",
      id: "1",
      name: "bash",
      input: { cmd: "ls" },
    });
    expect((await p.chat(req)).stopReason).toBe("end_turn");
    expect(p.callCount).toBe(2);
  });

  it("records a snapshot of each request", async () => {
    const p = new MockProvider([mockText("a")]);
    const mutable: ChatRequest = structuredClone(req);
    await p.chat(mutable);
    mutable.system = "changed";
    expect(p.requests[0]?.system).toBe("sys");
  });

  it("supports function steps that inspect the request", async () => {
    const p = new MockProvider([(r) => mockText(`saw ${String(r.messages.length)} message(s)`)]);
    const res = await p.chat(req);
    expect(res.content).toEqual([{ type: "text", text: "saw 1 message(s)" }]);
  });

  it("rejects once the script is exhausted", async () => {
    const p = new MockProvider([]);
    await expect(p.chat(req)).rejects.toThrow(/script exhausted/);
  });
});
