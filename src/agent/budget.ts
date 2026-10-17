import type { BudgetLimits } from "../config.js";

export type BudgetReason = "steps" | "cost" | "time";

export type BudgetCheck = { ok: true } | { ok: false; reason: BudgetReason; message: string };

export interface BudgetUsage {
  /** Completed model calls so far. */
  steps: number;
  costUsd: number;
}

/** The limit that is closest to running out, as a share of that limit. */
export interface BudgetUse {
  fraction: number;
  /** e.g. "24 of 30 minutes". */
  description: string;
}

/** Spec §7: step, cost and time limits. The clock is injectable so tests need no real waiting. */
export class Budget {
  private readonly startedAt: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** How much of the most used limit is gone. Drives the "wrap up" nudge. */
  used({ steps, costUsd }: BudgetUsage): BudgetUse {
    const minutes = this.elapsedMs / 60_000;
    const uses: BudgetUse[] = [
      {
        fraction: steps / this.limits.maxSteps,
        description: `${String(steps)} of ${String(this.limits.maxSteps)} steps`,
      },
      {
        fraction: costUsd / this.limits.maxCostUsd,
        description: `$${costUsd.toFixed(2)} of $${this.limits.maxCostUsd.toFixed(2)}`,
      },
      {
        fraction: minutes / this.limits.maxTimeMinutes,
        description: `${String(Math.floor(minutes))} of ${String(this.limits.maxTimeMinutes)} minutes`,
      },
    ];
    return uses.reduce((a, b) => (b.fraction > a.fraction ? b : a));
  }

  /** Call before each model call. Reports the first limit that is used up. */
  check({ steps, costUsd }: BudgetUsage): BudgetCheck {
    if (steps >= this.limits.maxSteps) {
      return exhausted("steps", `step limit reached (${String(this.limits.maxSteps)} steps)`);
    }
    if (costUsd >= this.limits.maxCostUsd) {
      return exhausted(
        "cost",
        `cost limit reached ($${costUsd.toFixed(4)} of $${this.limits.maxCostUsd.toFixed(2)})`,
      );
    }
    if (this.elapsedMs >= this.limits.maxTimeMinutes * 60_000) {
      return exhausted(
        "time",
        `time limit reached (${String(this.limits.maxTimeMinutes)} minutes)`,
      );
    }
    return { ok: true };
  }
}

const exhausted = (reason: BudgetReason, message: string): BudgetCheck => ({
  ok: false,
  reason,
  message,
});
