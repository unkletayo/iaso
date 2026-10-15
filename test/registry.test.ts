import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { createProvider } from "../src/providers/registry.js";

describe("createProvider", () => {
  it("builds an Anthropic adapter when the key is set", () => {
    const p = createProvider("anthropic:claude-sonnet-5-5", { env: { ANTHROPIC_API_KEY: "k" } });
    expect(p).toBeInstanceOf(AnthropicProvider);
    expect(p.id).toBe("anthropic:claude-sonnet-5-5");
  });

  it("builds OpenAI-compatible adapters for openai, openrouter and ollama", () => {
    expect(createProvider("openai:gpt-5", { env: { OPENAI_API_KEY: "k" } })).toBeInstanceOf(
      OpenAICompatibleProvider,
    );
    expect(
      createProvider("openrouter:deepseek/deepseek-chat", { env: { OPENROUTER_API_KEY: "k" } }),
    ).toBeInstanceOf(OpenAICompatibleProvider);
    expect(createProvider("ollama:qwen2.5-coder:32b", { env: {} })).toBeInstanceOf(
      OpenAICompatibleProvider,
    );
  });

  it("names the missing env var without leaking any value", () => {
    expect(() => createProvider("openai:gpt-5", { env: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() => createProvider("openai:gpt-5", { env: { OPENAI_API_KEY: "" } })).toThrow(
      /OPENAI_API_KEY/,
    );
  });

  it("rejects unknown models and lists the known ones", () => {
    expect(() => createProvider("nope:model", { env: {} })).toThrow(/Known models/);
  });

  it("reports gemini as not implemented, not as a missing key", () => {
    expect(() => createProvider("gemini:gemini-2.5-pro", { env: {} })).toThrow(/not implemented/);
  });
});
