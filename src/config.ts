import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_FILE_NAME = ".iaso.json";

const ServiceSchema = z.strictObject({
  name: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  ports: z.array(z.number().int().positive()).default([]),
});

/** Project config (`.iaso.json`). Every field is optional: env detection fills the rest. */
export const IasoConfigSchema = z.strictObject({
  image: z.string().min(1).optional(),
  installCommand: z.string().min(1).optional(),
  testCommand: z.string().min(1).optional(),
  /** Command template for related tests. `{files}` is replaced with changed paths. */
  relatedTestsPattern: z.string().min(1).optional(),
  /** Extra rules appended to the inner agent's system prompt. */
  extraRules: z.array(z.string().min(1)).default([]),
  services: z.array(ServiceSchema).default([]),
});

export type IasoConfig = z.infer<typeof IasoConfigSchema>;

export interface BudgetLimits {
  maxSteps: number;
  maxCostUsd: number;
  maxTimeMinutes: number;
}

export const BUDGET_DEFAULTS: BudgetLimits = {
  maxSteps: 50,
  maxCostUsd: 1.0,
  maxTimeMinutes: 20,
};

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ConfigError";
  }
}

/** Parse raw JSON text into a validated config. Throws `ConfigError` on any problem. */
export function parseConfig(text: string, path: string): IasoConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON (${err instanceof Error ? err.message : "unknown"})`, path);
  }
  const result = IasoConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(z.prettifyError(result.error), path);
  }
  return result.data;
}

/**
 * Load `.iaso.json` from `dir`, or from an explicit `configPath`.
 * A missing default file is not an error (returns defaults); a missing explicit file is.
 */
export function loadConfig(dir: string, configPath?: string): IasoConfig {
  const path = configPath ?? join(dir, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (configPath === undefined && isNotFound(err)) {
      return IasoConfigSchema.parse({});
    }
    throw new ConfigError(
      `cannot read file (${err instanceof Error ? err.message : "unknown"})`,
      path,
    );
  }
  return parseConfig(text, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}
