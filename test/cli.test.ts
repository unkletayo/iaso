import { describe, expect, it, vi } from "vitest";
import { buildProgram, main } from "../src/cli.js";
import { renderModels } from "../src/commands/models.js";
import { loadCatalogue } from "../src/models.js";

describe("renderModels", () => {
  const catalogue = loadCatalogue();

  it("lists every model with a header row", () => {
    const out = renderModels(catalogue, {});
    expect(out.split("\n")[0]).toMatch(/^MODEL\s+IN \$\/M/);
    for (const m of catalogue.models) expect(out).toContain(m.id);
  });

  it("shows key presence without leaking the key", () => {
    const out = renderModels(catalogue, { ANTHROPIC_API_KEY: "sk-secret-value" });
    expect(out).not.toContain("sk-secret-value");
    expect(out).toMatch(/anthropic:claude-sonnet-5-5.*set$/m);
    expect(out).toMatch(/openai:gpt-5.*missing$/m);
    expect(out).toMatch(/ollama:qwen2\.5-coder:32b.*n\/a$/m);
  });
});

describe("cli", () => {
  it("registers the planned commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(["run", "plan", "replay", "bench", "pr", "find", "models"]);
  });

  it("prints the model table for `models` and exits 0", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["node", "iaso", "models"])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("anthropic:claude-sonnet-5-5");
    log.mockRestore();
  });

  it("will not start a bench without --sample, so no paid run starts by accident", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["node", "iaso", "bench"])).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/Give --sample <n>/);
    err.mockRestore();
  });
});
