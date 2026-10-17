import { describe, expect, it } from "vitest";
import { Budget } from "../src/agent/budget.js";
import { BUDGET_DEFAULTS } from "../src/config.js";

function makeBudget(limits = BUDGET_DEFAULTS) {
  const clock = { now: 1_000_000 };
  return { clock, budget: new Budget(limits, () => clock.now) };
}

describe("Budget", () => {
  it("has the spec defaults: 50 steps, $1.00, 20 minutes", () => {
    expect(BUDGET_DEFAULTS).toEqual({ maxSteps: 50, maxCostUsd: 1, maxTimeMinutes: 20 });
  });

  it("is ok while every limit has room", () => {
    const { budget } = makeBudget();
    expect(budget.check({ steps: 49, costUsd: 0.99 })).toEqual({ ok: true });
  });

  it("stops at the step limit, not after it", () => {
    const { budget } = makeBudget();
    const res = budget.check({ steps: 50, costUsd: 0 });
    expect(res).toMatchObject({ ok: false, reason: "steps" });
  });

  it("stops at the cost limit and names the amounts", () => {
    const { budget } = makeBudget();
    const res = budget.check({ steps: 3, costUsd: 1.0123 });
    expect(res).toMatchObject({ ok: false, reason: "cost" });
    if (!res.ok) expect(res.message).toContain("$1.0123 of $1.00");
  });

  it("stops at the time limit using the injected clock", () => {
    const { budget, clock } = makeBudget();
    clock.now += 20 * 60_000 - 1;
    expect(budget.check({ steps: 1, costUsd: 0 }).ok).toBe(true);
    clock.now += 1;
    expect(budget.check({ steps: 1, costUsd: 0 })).toMatchObject({ ok: false, reason: "time" });
    expect(budget.elapsedMs).toBe(20 * 60_000);
  });

  it("respects custom limits and reports steps first when several are used up", () => {
    const { budget } = makeBudget({ maxSteps: 2, maxCostUsd: 0.05, maxTimeMinutes: 1 });
    expect(budget.check({ steps: 2, costUsd: 9 })).toMatchObject({ ok: false, reason: "steps" });
    expect(budget.check({ steps: 1, costUsd: 0.05 })).toMatchObject({ ok: false, reason: "cost" });
  });

  it("reports the most used limit as a share of that limit", () => {
    const { budget, clock } = makeBudget();
    expect(budget.used({ steps: 10, costUsd: 0.1 })).toMatchObject({
      fraction: 0.2,
      description: "10 of 50 steps",
    });
    expect(budget.used({ steps: 10, costUsd: 0.5 })).toMatchObject({
      fraction: 0.5,
      description: "$0.50 of $1.00",
    });
    clock.now += 18 * 60_000;
    expect(budget.used({ steps: 10, costUsd: 0.5 })).toMatchObject({
      fraction: 0.9,
      description: "18 of 20 minutes",
    });
  });
});
