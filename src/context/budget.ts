import type { ChatRequest, ContentBlock, Message, ToolDef } from "../providers/types.js";

/** Spec §7A point 1: between provider counts, estimate with characters / 3.5. */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "tool_call":
      return `${block.name}${JSON.stringify(block.input)}`;
    case "tool_result":
      return block.output;
  }
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) total += estimateTokens(blockText(block));
  }
  return total;
}

export function estimateToolsTokens(tools: readonly ToolDef[]): number {
  return estimateTokens(JSON.stringify(tools));
}

export function estimateRequestTokens(
  request: Pick<ChatRequest, "system" | "messages" | "tools">,
): number {
  return (
    estimateTokens(request.system) +
    estimateToolsTokens(request.tools) +
    estimateMessagesTokens(request.messages)
  );
}

/** Spec §7A point 6: all thresholds are a share of the model's context window. */
export const THRESHOLD_SHARE = { compactAt: 0.5, compactTarget: 0.25, hardLimit: 0.85 } as const;

export interface Thresholds {
  compactAt: number;
  compactTarget: number;
  hardLimit: number;
}

export function thresholdsFor(contextWindow: number): Thresholds {
  return {
    compactAt: Math.floor(contextWindow * THRESHOLD_SHARE.compactAt),
    compactTarget: Math.floor(contextWindow * THRESHOLD_SHARE.compactTarget),
    hardLimit: Math.floor(contextWindow * THRESHOLD_SHARE.hardLimit),
  };
}

/**
 * Tracks context size. The provider's input-token count is the truth for what it was sent; the
 * messages added since then are estimated. Call `reset` after history is rewritten (compaction,
 * staleness), because the last reported count no longer matches the messages.
 */
export class ContextMeter {
  private reported: { tokens: number; messageCount: number } | undefined;

  /** `messageCount` is how many messages the request that produced `inputTokens` contained. */
  record(inputTokens: number, messageCount: number): void {
    this.reported = { tokens: inputTokens, messageCount };
  }

  reset(): void {
    this.reported = undefined;
  }

  size(request: Pick<ChatRequest, "system" | "messages" | "tools">): number {
    if (!this.reported) return estimateRequestTokens(request);
    const added = request.messages.slice(this.reported.messageCount);
    return this.reported.tokens + estimateMessagesTokens(added);
  }
}
