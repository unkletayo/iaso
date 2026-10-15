export type Role = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; isError: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxOutputTokens: number;
  temperature?: number;
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

export interface ModelProvider {
  id: string; // e.g. "anthropic:claude-sonnet-5-5"
  chat(req: ChatRequest): Promise<ChatResponse>;
}
