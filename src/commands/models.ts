import type { Command } from "commander";
import { type Catalogue, PROVIDER_KEY_ENV, hasApiKey, loadCatalogue } from "../models.js";

const HEADERS = ["MODEL", "IN $/M", "OUT $/M", "CACHED $/M", "CONTEXT", "TOOLS", "KEY"] as const;

function formatPrice(value: number): string {
  return value.toFixed(2);
}

/** Render the catalogue as an aligned text table. Shows key presence, never the key. */
export function renderModels(catalogue: Catalogue, env: NodeJS.ProcessEnv = process.env): string {
  const rows = catalogue.models.map((m) => [
    m.id,
    formatPrice(m.inputPrice),
    formatPrice(m.outputPrice),
    formatPrice(m.cachedInputPrice),
    m.contextWindow.toLocaleString("en-US"),
    m.toolCalls ? "yes" : "no",
    PROVIDER_KEY_ENV[m.provider] === null ? "n/a" : hasApiKey(m.provider, env) ? "set" : "missing",
  ]);
  const widths = HEADERS.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();

  return [line(HEADERS), ...rows.map(line), "", `Prices: ${catalogue.priceStatus}`].join("\n");
}

export function registerModels(program: Command): void {
  program
    .command("models")
    .description("List the model catalogue and show which API keys are present")
    .action(() => {
      console.log(renderModels(loadCatalogue()));
    });
}
