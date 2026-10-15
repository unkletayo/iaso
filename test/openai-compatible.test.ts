import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, fromCompletion } from "../src/providers/openai-compatible.js";
import type { ChatRequest } from "../src/providers/types.js";

type Params = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
type Completion = OpenAI.Chat.ChatCompletion;

const openai = { id: "openai:gpt-5", apiModel: "gpt-5", provider: "openai" } as const;
const ollama = { id: "ollama:qwen", apiModel: "qwen", provider: "ollama" } as const;
const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

function completion(
  message: Partial<Completion["choices"][number]["message"]>,
  extra: Partial<Completion> = {},
  finish: Completion["choices"][number]["finish_reason"] = "stop",
): Completion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: finish,
        logprobs: null,
        message: { role: "assistant", content: null, refusal: null, ...message },
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    },
    ...extra,
  };
}

const req: ChatRequest = {
  system: "You fix bugs.",
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [{ name: "bash", description: "run", inputSchema: { type: "object", properties: {} } }],
  maxOutputTokens: 512,
  temperature: 0.3,
};

function fake(res: Completion = completion({ content: "ok" })) {
  return vi.fn<(p: Params) => Promise<Completion>>().mockResolvedValue(res);
}

describe("OpenAICompatibleProvider request mapping", () => {
  it("sends system message, function tools and max_completion_tokens for OpenAI (no temperature)", async () => {
    const create = fake();
    await new OpenAICompatibleProvider(openai, create).chat(req);
    const p = create.mock.calls[0]?.[0];
    expect(p?.model).toBe("gpt-5");
    expect(p?.messages[0]).toEqual({ role: "system", content: "You fix bugs." });
    expect(p?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "bash",
          description: "run",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(p?.max_completion_tokens).toBe(512);
    expect(p).not.toHaveProperty("max_tokens");
    expect(p).not.toHaveProperty("temperature");
  });

  it("uses max_tokens and temperature for other compatible servers", async () => {
    const create = fake();
    await new OpenAICompatibleProvider(ollama, create).chat(req);
    const p = create.mock.calls[0]?.[0];
    // `max_tokens` is deprecated in the SDK types but is what non-OpenAI servers accept.
    expect(p).toHaveProperty("max_tokens", 512);
    expect(p?.temperature).toBe(0.3);
    expect(p).not.toHaveProperty("max_completion_tokens");
  });

  it("omits tools when none are given", async () => {
    const create = fake();
    await new OpenAICompatibleProvider(ollama, create).chat({ ...req, tools: [] });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("converts tool calls and splits tool results into tool messages before user text", async () => {
    const create = fake();
    await new OpenAICompatibleProvider(ollama, create).chat({
      ...req,
      messages: [
        { role: "user", content: [{ type: "text", text: "start" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "running" },
            { type: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
            { type: "tool_call", id: "t2", name: "bash", input: { cmd: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "continue" },
            { type: "tool_result", id: "t1", output: "a.txt", isError: false },
            { type: "tool_result", id: "t2", output: "boom", isError: true },
          ],
        },
      ],
    });
    const msgs = create.mock.calls[0]?.[0].messages;
    expect(msgs?.[2]).toEqual({
      role: "assistant",
      content: "running",
      tool_calls: [
        { type: "function", id: "t1", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
        { type: "function", id: "t2", function: { name: "bash", arguments: '{"cmd":"pwd"}' } },
      ],
    });
    expect(msgs?.slice(3)).toEqual([
      { role: "tool", tool_call_id: "t1", content: "a.txt" },
      { role: "tool", tool_call_id: "t2", content: "[error] boom" },
      { role: "user", content: "continue" },
    ]);
  });
});

describe("fromCompletion", () => {
  it("maps text, usage (cached tokens) and end_turn", () => {
    const res = fromCompletion(completion({ content: "hello" }));
    expect(res.content).toEqual([{ type: "text", text: "hello" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 80 });
  });

  it("maps tool calls with parsed JSON arguments", () => {
    const res = fromCompletion(
      completion(
        {
          tool_calls: [
            { id: "t1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        },
        {},
        "tool_calls",
      ),
    );
    expect(res.content).toEqual([
      { type: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("reports tool_use even when the server says finish_reason stop", () => {
    const res = fromCompletion(
      completion({
        tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
    );
    expect(res.stopReason).toBe("tool_use");
  });

  it("keeps malformed argument JSON as raw text instead of throwing", () => {
    const res = fromCompletion(
      completion({
        tool_calls: [
          { id: "t1", type: "function", function: { name: "bash", arguments: "{oops" } },
        ],
      }),
    );
    expect(res.content[0]).toEqual({ type: "tool_call", id: "t1", name: "bash", input: "{oops" });
  });

  it("maps length to max_tokens and others to error; missing usage is zero", () => {
    expect(fromCompletion(completion({ content: "x" }, {}, "length")).stopReason).toBe(
      "max_tokens",
    );
    expect(fromCompletion(completion({ content: "x" }, {}, "content_filter")).stopReason).toBe(
      "error",
    );
    const noUsage = completion({ content: "x" });
    delete (noUsage as { usage?: unknown }).usage;
    expect(fromCompletion(noUsage).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("throws when there are no choices", () => {
    expect(() => fromCompletion({ ...completion({}), choices: [] })).toThrow(/no choices/);
  });
});

describe("OpenAICompatibleProvider retry", () => {
  it("retries a 503 then succeeds; does not retry a 400", async () => {
    const ok = vi
      .fn<(p: Params) => Promise<Completion>>()
      .mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }))
      .mockResolvedValue(completion({ content: "ok" }));
    await new OpenAICompatibleProvider(ollama, ok, fast).chat(req);
    expect(ok).toHaveBeenCalledTimes(2);

    const bad = vi
      .fn<(p: Params) => Promise<Completion>>()
      .mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }));
    await expect(new OpenAICompatibleProvider(ollama, bad, fast).chat(req)).rejects.toThrow("bad");
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
