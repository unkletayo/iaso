import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PROVIDERS = ["anthropic", "openai", "openrouter", "gemini", "ollama"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Env var holding the API key per provider. `null` means no key is needed (local server). */
export const PROVIDER_KEY_ENV: Record<Provider, string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  ollama: null,
};

const ModelEntrySchema = z
  .strictObject({
    /** `provider:model`, e.g. `ollama:qwen2.5-coder:32b`. */
    id: z.string().min(1),
    provider: z.enum(PROVIDERS),
    apiModel: z.string().min(1),
    baseUrl: z.url().optional(),
    /** USD per million tokens. */
    inputPrice: z.number().nonnegative(),
    outputPrice: z.number().nonnegative(),
    cachedInputPrice: z.number().nonnegative(),
    contextWindow: z.number().int().positive(),
    toolCalls: z.boolean(),
  })
  .refine((m) => m.id === `${m.provider}:${m.apiModel}`, {
    message: "id must equal `<provider>:<apiModel>`",
    path: ["id"],
  });

const CatalogueSchema = z
  .strictObject({
    priceStatus: z.string(),
    models: z.array(ModelEntrySchema).min(1),
  })
  .refine((c) => new Set(c.models.map((m) => m.id)).size === c.models.length, {
    message: "duplicate model id",
    path: ["models"],
  });

export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type Catalogue = z.infer<typeof CatalogueSchema>;

export const DEFAULT_CATALOGUE_PATH = fileURLToPath(new URL("../models.json", import.meta.url));

export function parseCatalogue(text: string): Catalogue {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `models.json: invalid JSON (${err instanceof Error ? err.message : "unknown"})`,
      { cause: err },
    );
  }
  const result = CatalogueSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`models.json: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadCatalogue(path: string = DEFAULT_CATALOGUE_PATH): Catalogue {
  return parseCatalogue(readFileSync(path, "utf8"));
}

/** Look up a model by `provider:model` id. Throws with the known ids when missing. */
export function findModel(catalogue: Catalogue, id: string): ModelEntry {
  const found = catalogue.models.find((m) => m.id === id);
  if (!found) {
    const known = catalogue.models.map((m) => m.id).join(", ");
    throw new Error(`Unknown model "${id}". Known models: ${known}`);
  }
  return found;
}

/** True when the provider's key is set (or none is required). Never reads the key value out. */
export function hasApiKey(provider: Provider, env: NodeJS.ProcessEnv = process.env): boolean {
  const name = PROVIDER_KEY_ENV[provider];
  if (name === null) return true;
  const value = env[name];
  return value !== undefined && value !== "";
}
