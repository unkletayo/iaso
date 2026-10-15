import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, fromAnthropicMessage } from "../src/providers/anthropic.js";
import type { ChatRequest } from "../src/providers/types.js";

const entry = { id: "anthropic:claude-sonnet-5-5", apiModel: "claude-sonnet-5-5" };
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

function reply(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50,
    },
    ...overrides,
  } as Anthropic.Message;
}

const req: ChatRequest = {
  system: "You fix bugs.",
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [
    { name: "bash", description: "run", inputSchema: { type: "object", properties: {} } },
    { name: "submit", description: "done", inputSchema: { type: "object", properties: {} } },
  ],
  maxOutputTokens: 1024,
  temperature: 0.2,
};

describe("AnthropicProvider request mapping", () => {
  it("sends model, system with cache control, tools with a cache breakpoint on the last", async () => {
    const create =
      vi.fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>();
    create.mockResolvedValue(reply());
    await new AnthropicProvider(entry, create).chat(req);

    const params = create.mock.calls[0]?.[0];
    expect(params?.model).toBe("claude-sonnet-5-5");
    expect(params?.max_tokens).toBe(1024);
    expect(params).not.toHaveProperty("temperature");
    expect(params?.system).toEqual([
      { type: "text", text: "You fix bugs.", cache_control: { type: "ephemeral" } },
    ]);
    const tools = params?.tools as Anthropic.Tool[];
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("omits tools when there are none", async () => {
    const create =
      vi.fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>();
    create.mockResolvedValue(reply());
    await new AnthropicProvider(entry, create).chat({ ...req, tools: [] });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("converts tool calls and puts tool results first in the user message", async () => {
    const create =
      vi.fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>();
    create.mockResolvedValue(reply());
    await new AnthropicProvider(entry, create).chat({
      ...req,
      messages: [
        { role: "user", content: [{ type: "text", text: "start" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "running" },
            { type: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "continue" },
            { type: "tool_result", id: "t1", output: "boom", isError: true },
          ],
        },
      ],
    });
    const msgs = create.mock.calls[0]?.[0].messages;
    expect(msgs?.[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "running" },
        { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
      ],
    });
    expect(msgs?.[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true },
        { type: "text", text: "continue" },
      ],
    });
  });
});

describe("AnthropicProvider response mapping", () => {
  it("maps text, tool_use, stop reason and usage (cache counters added back in)", () => {
    const res = fromAnthropicMessage(
      reply({
        content: [
          { type: "text", text: "calling", citations: null },
          { type: "tool_use", id: "t9", name: "bash", input: { cmd: "pwd" } },
        ] as Anthropic.ContentBlock[],
        stop_reason: "tool_use",
      }),
    );
    expect(res.content).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_call", id: "t9", name: "bash", input: { cmd: "pwd" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 550, outputTokens: 20, cachedInputTokens: 400 });
  });

  it("treats null cache counters as zero", () => {
    const res = fromAnthropicMessage(
      reply({
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        } as Anthropic.Usage,
      }),
    );
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 });
  });

  it("maps max_tokens, stop_sequence and unknown reasons", () => {
    expect(fromAnthropicMessage(reply({ stop_reason: "max_tokens" })).stopReason).toBe(
      "max_tokens",
    );
    expect(fromAnthropicMessage(reply({ stop_reason: "stop_sequence" })).stopReason).toBe(
      "end_turn",
    );
    expect(fromAnthropicMessage(reply({ stop_reason: "refusal" })).stopReason).toBe("error");
    expect(fromAnthropicMessage(reply({ stop_reason: null })).stopReason).toBe("error");
  });
});

describe("AnthropicProvider retry", () => {
  it("retries a 429 then succeeds", async () => {
    const create = vi
      .fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValue(reply());
    const res = await new AnthropicProvider(entry, create, fast).chat(req);
    expect(res.stopReason).toBe("end_turn");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401", async () => {
    const create = vi
      .fn<(p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>>()
      .mockRejectedValue(Object.assign(new Error("bad key"), { status: 401 }));
    await expect(new AnthropicProvider(entry, create, fast).chat(req)).rejects.toThrow("bad key");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
