import type { ModelEntry } from "../models.js";
import type { Usage } from "../providers/types.js";

export type ModelPrices = Pick<ModelEntry, "inputPrice" | "outputPrice" | "cachedInputPrice">;

const PER_MILLION = 1_000_000;

/**
 * Dollar cost of one response. `inputTokens` is the whole prompt including cached tokens, so the
 * cached part is billed at the cached price and only the rest at the full input price.
 */
export function computeCost(usage: Usage, prices: ModelPrices): number {
  // A provider reporting more cached than total input would give a negative charge; clamp it.
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return (
    (fresh * prices.inputPrice +
      cached * prices.cachedInputPrice +
      usage.outputTokens * prices.outputPrice) /
    PER_MILLION
  );
}

/** Running totals for one run. */
export class CostTracker {
  private total: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  private cost = 0;

  constructor(private readonly prices: ModelPrices) {}

  /** Add one response's usage and return the cost of that response alone. */
  add(usage: Usage): number {
    const stepCost = computeCost(usage, this.prices);
    this.total = {
      inputTokens: this.total.inputTokens + usage.inputTokens,
      outputTokens: this.total.outputTokens + usage.outputTokens,
      cachedInputTokens: this.total.cachedInputTokens + usage.cachedInputTokens,
    };
    this.cost += stepCost;
    return stepCost;
  }

  get costUsd(): number {
    return this.cost;
  }

  get usage(): Usage {
    return { ...this.total };
  }
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}
