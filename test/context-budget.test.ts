import { describe, expect, it } from "vitest";
import {
  ContextMeter,
  estimateMessagesTokens,
  estimateRequestTokens,
  estimateTokens,
  thresholdsFor,
} from "../src/context/budget.js";
import type { Message } from "../src/providers/types.js";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

describe("estimateTokens", () => {
  it("is characters / 3.5, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(7))).toBe(2);
    expect(estimateTokens("x".repeat(8))).toBe(3);
  });

  it("counts text, tool calls and tool results", () => {
    const messages: Message[] = [
      user("x".repeat(35)),
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "1", name: "bash", input: { cmd: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", id: "1", output: "y".repeat(70), isError: false }],
      },
    ];
    // 35/3.5 = 10, `bash{"cmd":"ls"}` = 16 chars -> 5, 70/3.5 = 20
    expect(estimateMessagesTokens(messages)).toBe(35);
  });

  it("includes system prompt and tool definitions in a request", () => {
    const tools = [{ name: "t", description: "d", inputSchema: {} }];
    const base = estimateRequestTokens({ system: "", messages: [], tools: [] });
    expect(estimateRequestTokens({ system: "x".repeat(35), messages: [], tools: [] })).toBe(
      base + 10,
    );
    expect(estimateRequestTokens({ system: "", messages: [], tools })).toBeGreaterThan(base);
  });
});

describe("thresholdsFor", () => {
  it("is 50% / 25% / 85% of the window", () => {
    expect(thresholdsFor(200_000)).toEqual({
      compactAt: 100_000,
      compactTarget: 50_000,
      hardLimit: 170_000,
    });
  });

  it("scales to any window", () => {
    expect(thresholdsFor(8_192).compactAt).toBe(4_096);
  });
});

describe("ContextMeter", () => {
  const empty = { system: "", tools: [] };

  it("estimates everything before the first provider count", () => {
    const meter = new ContextMeter();
    const request = { ...empty, messages: [user("x".repeat(35))] };
    expect(meter.size(request)).toBe(estimateRequestTokens(request));
  });

  it("uses the provider count for old messages and estimates only the new ones", () => {
    const meter = new ContextMeter();
    meter.record(5_000, 1);
    const size = meter.size({ ...empty, messages: [user("x".repeat(35)), user("y".repeat(70))] });
    expect(size).toBe(5_000 + 20);
  });

  it("goes back to estimating after reset", () => {
    const meter = new ContextMeter();
    meter.record(5_000, 1);
    meter.reset();
    const request = { ...empty, messages: [user("x".repeat(35))] };
    expect(meter.size(request)).toBe(estimateRequestTokens(request));
  });
});
