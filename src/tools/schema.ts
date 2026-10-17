import { z } from "zod";
import type { RunState } from "../context/state.js";
import type { ToolDef } from "../providers/types.js";
import type { Sandbox } from "../sandbox/types.js";
import { type FieldKinds, repairInput } from "./repair.js";
import { truncateOutput } from "./truncate.js";

/** What a tool hands back to the loop. Failures are results with `isError: true`, never throws. */
export interface ToolResult {
  output: string;
  isError: boolean;
}

export interface ToolContext {
  sandbox: Sandbox;
  /** 1-based loop step that triggered the call. */
  step: number;
  /** Per-run state shared by `notes` and `submit`. The loop provides it; file tools ignore it. */
  run?: RunState;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** zod schema: the single source of truth for validation and the JSON Schema sent to models. */
  input: S;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  definition: ToolDefinition<S>;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}

/** Convert to the provider-neutral shape. Each adapter then converts that to its vendor format. */
export function toToolDef(definition: ToolDefinition): ToolDef {
  // `$schema` is metadata some providers reject, and models do not need it.
  const inputSchema: Record<string, unknown> = {
    ...z.toJSONSchema(definition.input, { io: "input" }),
  };
  delete inputSchema.$schema;
  return { name: definition.name, description: definition.description, inputSchema };
}

export type ParsedInput<S extends z.ZodType> =
  { ok: true; value: z.infer<S> } | { ok: false; error: string };

export function parseToolInput<S extends z.ZodType>(
  definition: ToolDefinition<S>,
  raw: unknown,
): ParsedInput<S> {
  const result = definition.input.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  // Models sometimes write an array as a string, or paste parameters into one another. If the
  // repaired call is valid it is the call the model meant; if not, report the original error.
  const repaired = definition.input.safeParse(repairInput(raw, fieldKinds(definition)));
  if (repaired.success) return { ok: true, value: repaired.data };

  // Provider adapters keep unparseable tool arguments as a raw string.
  const hint =
    typeof raw === "string" ? "The tool input was not valid JSON. Send a JSON object.\n" : "";
  const fields = describeFields(definition);
  return {
    ok: false,
    error: `${hint}${z.prettifyError(result.error)}${fields === "" ? "" : `\n${fields}`}`,
  };
}

interface InputShape {
  properties?: Record<string, { type?: unknown }>;
  required?: string[];
}

const inputShape = (definition: ToolDefinition): InputShape =>
  z.toJSONSchema(definition.input, { io: "input" }) as InputShape;

/** What type each field of the tool's input must have. */
function fieldKinds(definition: ToolDefinition): FieldKinds {
  const kinds: FieldKinds = {};
  for (const [name, prop] of Object.entries(inputShape(definition).properties ?? {})) {
    const type = prop.type;
    kinds[name] = type === "string" || type === "array" || type === "object" ? type : "other";
  }
  return kinds;
}

/**
 * "Fields: a (required), b (optional)". A model that keeps leaving a field out often fixes it once
 * it sees the whole list, not just the complaint about one field.
 */
function describeFields(definition: ToolDefinition): string {
  const schema = inputShape(definition);
  const names = Object.keys(schema.properties ?? {});
  if (names.length === 0) return "";
  const required = new Set(schema.required);
  const list = names.map((n) => `${n} (${required.has(n) ? "required" : "optional"})`);
  return `Fields of ${definition.name}: ${list.join(", ")}. Send every required field in one call.`;
}

export interface RunToolOptions {
  /** Cut long output to the standard limit. The loop turns this off so it can store the raw text. */
  truncate?: boolean;
}

/**
 * Validate input, run the tool, and turn every failure into an error result the model can read.
 * Output is truncated here by default so no tool can flood the context.
 */
export async function runTool(
  tool: Tool,
  raw: unknown,
  ctx: ToolContext,
  { truncate = true }: RunToolOptions = {},
): Promise<ToolResult> {
  const cut = (text: string): string => (truncate ? truncateOutput(text) : text);
  const parsed = parseToolInput(tool.definition, raw);
  if (!parsed.ok) {
    return { output: `Invalid input for ${tool.definition.name}:\n${parsed.error}`, isError: true };
  }
  try {
    const result = await tool.run(parsed.value, ctx);
    return { output: cut(result.output), isError: result.isError };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: cut(`${tool.definition.name} failed: ${message}`), isError: true };
  }
}
