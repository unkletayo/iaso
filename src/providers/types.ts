export type Role = "user" | "assistant";

export type ContentBlock =
  /** `cacheBreakpoint` asks the provider to cache the prompt up to and including this block. */
  | { type: "text"; text: string; cacheBreakpoint?: true }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean; cacheBreakpoint?: true };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/** How hard the model should think, in the vendors' own words. Each adapter maps it. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxOutputTokens: number;
  temperature?: number;
  /** Omitted: the vendor's default. Only sent to a model whose catalogue entry accepts it. */
  effort?: Effort;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ChatResponse {
  content: ContentBlock[];
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "error";
  usage: Usage;
}

/** Per-call options, kept out of `ChatRequest` so requests stay plain data that can be logged. */
export interface ChatOptions {
  signal?: AbortSignal;
  /**
   * Called with each piece of the model's text as it arrives. With it the adapter streams the
   * response; without it the call is a plain request. The returned `ChatResponse` is the same
   * either way.
   */
  onText?: (delta: string) => void;
}

export interface ModelProvider {
  id: string; // e.g. "anthropic:claude-sonnet-5-5"
  /**
   * `signal` aborts the call, retries included (used for the run's time limit). `onText` streams
   * the text as it is written (M13 step 13F).
   */
  chat(req: ChatRequest, options?: ChatOptions): Promise<ChatResponse>;
}
