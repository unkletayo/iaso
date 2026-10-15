import { type Catalogue, PROVIDER_KEY_ENV, findModel, loadCatalogue } from "../models.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./types.js";

export interface RegistryOptions {
  catalogue?: Catalogue;
  env?: NodeJS.ProcessEnv;
}

/** Local servers ignore the key, but the OpenAI SDK refuses an empty one. */
const KEYLESS_PLACEHOLDER = "not-needed";

/**
 * Resolve a `provider:model` id to a ready adapter.
 * Fails with the env var name (never its value) when a key is missing.
 */
export function createProvider(id: string, opts: RegistryOptions = {}): ModelProvider {
  const catalogue = opts.catalogue ?? loadCatalogue();
  const env = opts.env ?? process.env;
  const entry = findModel(catalogue, id);
  if (entry.provider === "gemini") {
    throw new Error(`Provider "gemini" is not implemented yet (planned for M8).`);
  }

  const keyName = PROVIDER_KEY_ENV[entry.provider];
  const apiKey = keyName === null ? KEYLESS_PLACEHOLDER : env[keyName];
  if (apiKey === undefined || apiKey === "") {
    throw new Error(`Model "${id}" needs the ${String(keyName)} environment variable to be set.`);
  }

  switch (entry.provider) {
    case "anthropic":
      return createAnthropicProvider(entry, apiKey);
    case "openai":
    case "openrouter":
    case "ollama":
      return createOpenAICompatibleProvider(entry, apiKey);
  }
}
