import { describe, expect, it } from "vitest";
import { findModel, hasApiKey, loadCatalogue, parseCatalogue } from "../src/models.js";

const validModel = {
  id: "openai:gpt-5",
  provider: "openai",
  apiModel: "gpt-5",
  inputPrice: 1,
  outputPrice: 2,
  cachedInputPrice: 0.1,
  contextWindow: 1000,
  toolCalls: true,
};

const valid = { priceStatus: "test", models: [validModel] };

function withModel(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...valid, models: [{ ...validModel, ...overrides }] });
}

describe("catalogue", () => {
  it("loads the shipped models.json", () => {
    const cat = loadCatalogue();
    expect(cat.models.length).toBeGreaterThanOrEqual(6);
    expect(findModel(cat, "ollama:qwen2.5-coder:32b").apiModel).toBe("qwen2.5-coder:32b");
  });

  it("rejects an id that does not match provider:apiModel", () => {
    expect(() => parseCatalogue(withModel({ id: "openai:other" }))).toThrow(/id must equal/);
  });

  it("rejects duplicate ids", () => {
    const dup = { ...valid, models: [validModel, validModel] };
    expect(() => parseCatalogue(JSON.stringify(dup))).toThrow(/duplicate model id/);
  });

  it("rejects negative prices", () => {
    expect(() => parseCatalogue(withModel({ inputPrice: -1 }))).toThrow();
  });

  it("lists known ids when a model is unknown", () => {
    expect(() => findModel(parseCatalogue(JSON.stringify(valid)), "x:y")).toThrow(/openai:gpt-5/);
  });
});

describe("hasApiKey", () => {
  it("is true when the env var is set", () => {
    expect(hasApiKey("anthropic", { ANTHROPIC_API_KEY: "k" })).toBe(true);
  });

  it("is false when unset or empty", () => {
    expect(hasApiKey("openai", {})).toBe(false);
    expect(hasApiKey("openai", { OPENAI_API_KEY: "" })).toBe(false);
  });

  it("is true for providers that need no key", () => {
    expect(hasApiKey("ollama", {})).toBe(true);
  });
});
