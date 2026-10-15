import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostTracker, computeCost, formatCost } from "../src/telemetry/cost.js";
import {
  LOGGED_RESULT_CHARS,
  TrajectoryWriter,
  type TrajectoryStep,
  readTrajectory,
  trajectoryPath,
} from "../src/telemetry/trajectory.js";

const prices = { inputPrice: 3, outputPrice: 15, cachedInputPrice: 0.3 };

describe("computeCost", () => {
  it("bills fresh input, cached input and output at their own prices", () => {
    // 600k fresh * $3 + 400k cached * $0.3 + 100k out * $15, per million
    const cost = computeCost(
      { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
      prices,
    );
    expect(cost).toBeCloseTo(1.8 + 0.12 + 1.5, 10);
  });

  it("is zero for no usage and for free (local) models", () => {
    const none = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    expect(computeCost(none, prices)).toBe(0);
    const free = { inputPrice: 0, outputPrice: 0, cachedInputPrice: 0 };
    expect(computeCost({ inputTokens: 5000, cachedInputTokens: 0, outputTokens: 500 }, free)).toBe(
      0,
    );
  });

  it("never goes negative when a provider reports more cached than total input", () => {
    const cost = computeCost({ inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 }, prices);
    expect(cost).toBeCloseTo((100 * 0.3) / 1_000_000, 12);
  });
});

describe("CostTracker", () => {
  it("accumulates usage and cost, and returns each step's own cost", () => {
    const t = new CostTracker(prices);
    const first = t.add({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 });
    const second = t.add({ inputTokens: 2000, cachedInputTokens: 1000, outputTokens: 50 });
    expect(first).toBeCloseTo((1000 * 3 + 100 * 15) / 1e6, 12);
    expect(t.costUsd).toBeCloseTo(first + second, 12);
    expect(t.usage).toEqual({ inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 150 });
  });

  it("returns a copy of usage, so callers cannot change the totals", () => {
    const t = new CostTracker(prices);
    t.usage.inputTokens = 99;
    expect(t.usage.inputTokens).toBe(0);
  });
});

describe("formatCost", () => {
  it("shows 4 decimals for tiny amounts and 2 otherwise", () => {
    expect(formatCost(0.00123)).toBe("$0.0012");
    expect(formatCost(0.1234)).toBe("$0.12");
    expect(formatCost(0)).toBe("$0.0000");
  });
});

const step = (n: number, output = "ok"): TrajectoryStep => ({
  step: n,
  phase: "reproduce",
  model: "mock:m",
  promptVersion: "1.0.0",
  tokens: { input: 100, output: 10, cachedInput: 0 },
  contextTokens: 120,
  response: { text: "running tests", stopReason: "tool_use" },
  toolCalls: [{ id: "t1", name: "bash", input: { cmd: "npm test" } }],
  toolResults: [{ id: "t1", name: "bash", output, isError: false }],
  costUsd: 0.001,
  durationMs: 42,
});

describe("trajectory", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "iaso-traj-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts the file at runs/<runId>/trajectory.jsonl", () => {
    expect(trajectoryPath("runs", "abc")).toBe(join("runs", "abc", "trajectory.jsonl"));
  });

  it("creates the run folder and writes one JSON line per step, in order", async () => {
    const path = trajectoryPath(join(dir, "runs"), "r1");
    const w = new TrajectoryWriter(path);
    await w.append(step(1));
    await w.append(step(2));
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ step: 2, promptVersion: "1.0.0" });
    expect(await readTrajectory(path)).toEqual([step(1), step(2)]);
  });

  it("trims long tool results in the log", async () => {
    const path = trajectoryPath(dir, "r2");
    await new TrajectoryWriter(path).append(step(1, "x".repeat(50_000)));
    const [logged] = await readTrajectory(path);
    const out = logged?.toolResults[0]?.output ?? "";
    expect(out.length).toBeLessThan(LOGGED_RESULT_CHARS + 100);
    expect(out).toContain("characters cut");
  });

  it("refuses to write a malformed step instead of logging garbage", async () => {
    const w = new TrajectoryWriter(trajectoryPath(dir, "r3"));
    await expect(w.append({ ...step(1), step: 0 })).rejects.toThrow();
  });

  it("names the line number of a corrupt line when reading", async () => {
    const path = join(dir, "bad.jsonl");
    await writeFile(path, `${JSON.stringify(step(1))}\nnot json\n`);
    await expect(readTrajectory(path)).rejects.toThrow(/bad\.jsonl: line 2/);
  });
});
