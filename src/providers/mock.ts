import type { ChatRequest, ChatResponse, ContentBlock, ModelProvider } from "./types.js";

export type ScriptedStep = ChatResponse | ((req: ChatRequest) => ChatResponse);

/** Helpers to script responses in tests. */
export const mockText = (text: string): ChatResponse => ({
  content: [{ type: "text", text }],
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
});

export const mockToolCall = (
  id: string,
  name: string,
  input: unknown,
  extra: ContentBlock[] = [],
): ChatResponse => ({
  content: [...extra, { type: "tool_call", id, name, input }],
  stopReason: "tool_use",
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
});

/** Replays scripted responses in order and records every request. Costs nothing. */
export class MockProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: readonly ScriptedStep[],
    readonly id = "mock:scripted",
  ) {}

  chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    const step = this.script[this.index];
    if (step === undefined) {
      return Promise.reject(
        new Error(`MockProvider: script exhausted after ${String(this.index)} responses`),
      );
    }
    this.index += 1;
    return Promise.resolve(typeof step === "function" ? step(req) : step);
  }

  get callCount(): number {
    return this.index;
  }
}
