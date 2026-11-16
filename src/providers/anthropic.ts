import Anthropic from "@anthropic-ai/sdk";
import type { ModelEntry } from "../models.js";
import { type RetryOptions, StreamInterruptedError, withRetry } from "./retry.js";
import type {
  ChatOptions,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Message,
  ModelProvider,
  ToolDef,
} from "./types.js";

/** The one SDK call the adapter needs. Tests inject a fake. */
export type CreateMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: ChatOptions,
) => Promise<Anthropic.Message>;

/** The slice of the SDK's `MessageStream` the adapter uses. */
export interface MessageStreamLike {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

/** The streaming SDK call. Tests inject a fake. */
export type StreamMessage = (
  params: Anthropic.MessageCreateParamsNonStreaming,
  options?: ChatOptions,
) => MessageStreamLike;

const CACHE: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  if (msg.role === "assistant") {
    const content = msg.content.flatMap((b): Anthropic.ContentBlockParam[] => {
      if (b.type === "text") return b.text === "" ? [] : [{ type: "text", text: b.text }];
      if (b.type === "tool_call") {
        return [{ type: "tool_use", id: b.id, name: b.name, input: b.input }];
      }
      return [];
    });
    return { role: "assistant", content };
  }
  // Anthropic requires tool_result blocks to come first in a user message.
  const results: Anthropic.ContentBlockParam[] = [];
  const texts: Anthropic.ContentBlockParam[] = [];
  for (const b of msg.content) {
    if (b.type === "tool_result") {
      results.push({
        type: "tool_result",
        tool_use_id: b.id,
        content: b.output,
        is_error: b.isError,
        ...(b.cacheBreakpoint ? { cache_control: CACHE } : {}),
      });
    } else if (b.type === "text" && b.text !== "") {
      texts.push({
        type: "text",
        text: b.text,
        ...(b.cacheBreakpoint ? { cache_control: CACHE } : {}),
      });
    }
  }
  return { role: "user", content: [...results, ...texts] };
}

/**
 * No cache breakpoint here: tools come before the system prompt in the cached prefix, so the
 * system prompt's breakpoint covers them. Anthropic allows 4 breakpoints and the request uses all
 * four: system, pinned layer, summary, and the end of the history.
 */
function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // ToolDef.inputSchema is provider-neutral JSON Schema; Anthropic types it as an object schema.
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

function fromStopReason(reason: Anthropic.StopReason | null): ChatResponse["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    default:
      return "error";
  }
}

export function fromAnthropicMessage(res: Anthropic.Message): ChatResponse {
  const content: ContentBlock[] = [];
  for (const b of res.content) {
    if (b.type === "text") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") {
      content.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    }
  }
  const cacheRead = res.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = res.usage.cache_creation_input_tokens ?? 0;
  return {
    content,
    stopReason: fromStopReason(res.stop_reason),
    usage: {
      // Neutral convention: inputTokens is the whole prompt, cachedInputTokens the cached part of it.
      // Anthropic reports uncached input separately, so add the cache counters back in.
      inputTokens: res.usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: res.usage.output_tokens,
      cachedInputTokens: cacheRead,
    },
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly entry: Pick<ModelEntry, "id" | "apiModel">,
    private readonly create: CreateMessage,
    private readonly retry: Partial<RetryOptions> = {},
    /** Without it `onText` is ignored and every call is a plain request. */
    private readonly stream?: StreamMessage,
  ) {
    this.id = entry.id;
  }

  /** Stream when the caller wants the text as it comes; otherwise one plain request. */
  private call(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options: ChatOptions,
  ): Promise<Anthropic.Message> {
    const { stream } = this;
    const { onText } = options;
    if (stream === undefined || onText === undefined) return this.create(params, options);
    let started = false;
    const s = stream(params, options);
    s.on("text", (delta) => {
      started = true;
      onText(delta);
    });
    return s.finalMessage().catch((err: unknown) => {
      throw started ? new StreamInterruptedError(err) : err;
    });
  }

  async chat(req: ChatRequest, options: ChatOptions = {}): Promise<ChatResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.entry.apiModel,
      max_tokens: req.maxOutputTokens,
      // Cache breakpoint on the system prompt (the stable, pinned prefix).
      system: [{ type: "text", text: req.system, cache_control: CACHE }],
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools.length > 0 ? { tools: toAnthropicTools(req.tools) } : {}),
      // Effort steers the adaptive thinking the current models run by default; no `thinking` param
      // is sent, because the fixed-budget form is rejected by them (M13 step 13E).
      ...(req.effort === undefined ? {} : { output_config: { effort: req.effort } }),
      // `req.temperature` is deliberately not sent: the SDK marks it deprecated for newer models,
      // and any value other than 1.0 gets a 400. Vary attempts by model instead (M13).
    };
    const res = await withRetry(() => this.call(params, options), this.retry, options.signal);
    return fromAnthropicMessage(res);
  }
}

/** Build a real provider. The SDK's own retries are off: `withRetry` owns that. */
export function createAnthropicProvider(entry: ModelEntry, apiKey: string): AnthropicProvider {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const requestOptions = (options?: ChatOptions) =>
    options?.signal ? { signal: options.signal } : {};
  return new AnthropicProvider(
    entry,
    (params, options) => client.messages.create(params, requestOptions(options)),
    {},
    (params, options) => client.messages.stream(params, requestOptions(options)),
  );
}
