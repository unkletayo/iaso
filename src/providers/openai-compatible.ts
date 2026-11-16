import OpenAI from "openai";
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

type Params = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
/** The request as the adapter builds it: `stream` is left to the call that sends it. */
type PlainParams = Omit<Params, "stream">;
type Completion = OpenAI.Chat.ChatCompletion;
type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

/** The one SDK call the adapter needs. Tests inject a fake. */
export type CreateCompletion = (params: Params, options?: ChatOptions) => Promise<Completion>;

/** The slice of the SDK's `ChatCompletionStream` the adapter uses. */
export interface CompletionStreamLike {
  on(event: "content", listener: (delta: string) => void): unknown;
  finalChatCompletion(): Promise<Completion>;
}

/** The streaming SDK call. Tests inject a fake. */
export type StreamCompletion = (params: PlainParams, options?: ChatOptions) => CompletionStreamLike;

function toChatMessages(msg: Message): ChatMessage[] {
  if (msg.role === "assistant") {
    const text = msg.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = msg.content.flatMap((b) =>
      b.type === "tool_call"
        ? [
            {
              type: "function" as const,
              id: b.id,
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            },
          ]
        : [],
    );
    return [
      {
        role: "assistant",
        content: text === "" ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }
  // Tool results become one `tool` message each, and must directly follow the assistant tool calls.
  const results: ChatMessage[] = [];
  const texts: string[] = [];
  for (const b of msg.content) {
    if (b.type === "tool_result") {
      // The chat API has no error flag on tool messages, so mark errors in the text.
      results.push({
        role: "tool",
        tool_call_id: b.id,
        content: b.isError ? `[error] ${b.output}` : b.output,
      });
    } else if (b.type === "text" && b.text !== "") {
      texts.push(b.text);
    }
  }
  return texts.length > 0 ? [...results, { role: "user", content: texts.join("\n") }] : results;
}

function toChatTools(tools: ToolDef[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Keep the raw text: tool input validation will reject it and the model sees that error.
    return raw;
  }
}

export function fromCompletion(res: Completion): ChatResponse {
  const choice = res.choices[0];
  if (!choice) throw new Error("Provider returned no choices");

  const content: ContentBlock[] = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }

  const hasToolCalls = content.some((b) => b.type === "tool_call");
  let stopReason: ChatResponse["stopReason"];
  // Some servers (e.g. Ollama) report "stop" even when tool calls are present.
  if (hasToolCalls) stopReason = "tool_use";
  else if (choice.finish_reason === "stop") stopReason = "end_turn";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";
  else stopReason = "error";

  return {
    content,
    stopReason,
    usage: {
      // prompt_tokens already includes cached tokens, matching the neutral convention.
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly entry: Pick<ModelEntry, "id" | "apiModel" | "provider">,
    private readonly create: CreateCompletion,
    private readonly retry: Partial<RetryOptions> = {},
    /** Without it `onText` is ignored and every call is a plain request. */
    private readonly stream?: StreamCompletion,
  ) {
    this.id = entry.id;
  }

  /** Stream when the caller wants the text as it comes; otherwise one plain request. */
  private call(params: PlainParams, options: ChatOptions): Promise<Completion> {
    const { stream } = this;
    const { onText } = options;
    if (stream === undefined || onText === undefined) return this.create(params, options);
    let started = false;
    // A streamed response carries no token counts unless asked; without them the cost would read 0.
    const s = stream({ ...params, stream_options: { include_usage: true } }, options);
    s.on("content", (delta) => {
      started = true;
      onText(delta);
    });
    return s.finalChatCompletion().catch((err: unknown) => {
      throw started ? new StreamInterruptedError(err) : err;
    });
  }

  async chat(req: ChatRequest, options: ChatOptions = {}): Promise<ChatResponse> {
    const isOpenAI = this.entry.provider === "openai";
    const params: PlainParams = {
      model: this.entry.apiModel,
      messages: [{ role: "system", content: req.system }, ...req.messages.flatMap(toChatMessages)],
      // OpenAI wants `max_completion_tokens`; most other compatible servers only know `max_tokens`.
      ...(isOpenAI
        ? { max_completion_tokens: req.maxOutputTokens }
        : { max_tokens: req.maxOutputTokens }),
      ...(req.tools.length > 0 ? { tools: toChatTools(req.tools) } : {}),
      // OpenAI's reasoning models reject any non-default temperature, so only send it elsewhere.
      ...(!isOpenAI && req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.effort === undefined ? {} : { reasoning_effort: req.effort }),
    };
    const res = await withRetry(() => this.call(params, options), this.retry, options.signal);
    return fromCompletion(res);
  }
}

/** Build a real provider. The SDK's own retries are off: `withRetry` owns that. */
export function createOpenAICompatibleProvider(
  entry: ModelEntry,
  apiKey: string,
): OpenAICompatibleProvider {
  const client = new OpenAI({
    apiKey,
    maxRetries: 0,
    ...(entry.baseUrl !== undefined ? { baseURL: entry.baseUrl } : {}),
  });
  const requestOptions = (options?: ChatOptions) =>
    options?.signal ? { signal: options.signal } : {};
  return new OpenAICompatibleProvider(
    entry,
    (params, options) => client.chat.completions.create(params, requestOptions(options)),
    {},
    (params, options) => client.chat.completions.stream(params, requestOptions(options)),
  );
}
