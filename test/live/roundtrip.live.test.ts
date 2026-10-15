import { describe, expect, it } from "vitest";
import { hasApiKey, loadCatalogue, findModel } from "../../src/models.js";
import { createProvider } from "../../src/providers/registry.js";
import type { ChatRequest, ToolDef } from "../../src/providers/types.js";

/**
 * One real tool-call round trip per provider. Costs a few cents.
 * Run with: IASO_LIVE=1 ANTHROPIC_API_KEY=... npx vitest run test/live
 * Override the model list with IASO_LIVE_MODELS=id1,id2.
 */
const DEFAULT_MODELS = ["anthropic:claude-haiku-5-5"];
const models = (process.env.IASO_LIVE_MODELS?.split(",") ?? DEFAULT_MODELS).map((m) => m.trim());
const catalogue = loadCatalogue();

const tool: ToolDef = {
  name: "get_magic_number",
  description: "Returns the magic number. Call it whenever asked for the magic number.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

for (const id of models) {
  const provider = findModel(catalogue, id).provider;
  describe.skipIf(!hasApiKey(provider))(`live round trip: ${id}`, () => {
    it("calls the tool, accepts the result, and answers", { timeout: 60_000 }, async () => {
      const llm = createProvider(id);
      const base: ChatRequest = {
        system: "You are a test agent. Use tools when asked.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "What is the magic number? Use the tool." }],
          },
        ],
        tools: [tool],
        maxOutputTokens: 256,
      };

      const first = await llm.chat(base);
      expect(first.stopReason).toBe("tool_use");
      const call = first.content.find((b) => b.type === "tool_call");
      expect(call).toMatchObject({ type: "tool_call", name: "get_magic_number" });
      if (call?.type !== "tool_call") throw new Error("no tool call returned");
      expect(first.usage.inputTokens).toBeGreaterThan(0);
      expect(first.usage.outputTokens).toBeGreaterThan(0);

      const second = await llm.chat({
        ...base,
        messages: [
          ...base.messages,
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [{ type: "tool_result", id: call.id, output: "4242", isError: false }],
          },
        ],
      });
      expect(second.stopReason).toBe("end_turn");
      const text = second.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      expect(text).toContain("4242");
    });
  });
}
