import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DatasetError,
  type SweInstance,
  loadSweLite,
  renderSweIssue,
  sampleInstances,
} from "../src/sources/swebench.js";

const SHA = "d16bfe05a744909de4b27f5875fe0d4ed41ce607";
const ROWS = 250;

/** Rows as the datasets server sends them, with the fields the agent must never see. */
const row = (i: number) => ({
  row_idx: i,
  row: {
    instance_id: `owner__repo-${String(i).padStart(4, "0")}`,
    repo: "owner/repo",
    base_commit: SHA,
    problem_statement: `Bug number ${String(i)}`,
    patch: "diff --git a/fix.py b/fix.py\nTHE REAL FIX",
    test_patch: "diff --git a/test_x.py b/test_x.py\nHIDDEN TEST",
    FAIL_TO_PASS: '["test_x"]',
    PASS_TO_PASS: "[]",
  },
});

function datasetServer(total = ROWS) {
  return vi.fn((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const offset = Number(url.searchParams.get("offset"));
    const length = Number(url.searchParams.get("length"));
    const rows = Array.from({ length: Math.max(0, Math.min(length, total - offset)) }, (_, k) =>
      row(offset + k),
    );
    return Promise.resolve(new Response(JSON.stringify({ num_rows_total: total, rows })));
  });
}

const asFetch = (f: ReturnType<typeof datasetServer>): typeof fetch => f;
const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), "iaso-swe-"));
const noWait = { sleep: () => Promise.resolve(), random: () => 0.5 };

describe("loadSweLite", () => {
  it("reads every page, sorted by id", async () => {
    const server = datasetServer();
    const all = await loadSweLite({ fetch: asFetch(server), cacheDir: await tmp() });
    expect(all).toHaveLength(ROWS);
    expect(all[0]?.instanceId).toBe("owner__repo-0000");
    expect(all.at(-1)?.instanceId).toBe("owner__repo-0249");
    expect(server).toHaveBeenCalledTimes(3);
    const urls = server.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : ""));
    expect(urls[0]).toContain("dataset=princeton-nlp%2FSWE-bench_Lite");
    expect(urls[0]).toContain("split=test");
  });

  it("keeps the real fix and the hidden tests out of memory and out of the cache", async () => {
    const cacheDir = await tmp();
    const all = await loadSweLite({ fetch: asFetch(datasetServer()), cacheDir });
    const inMemory = JSON.stringify(all);
    const onDisk = await readFile(join(cacheDir, "swebench-lite.json"), "utf8");
    for (const text of [inMemory, onDisk]) {
      expect(text).not.toContain("HIDDEN TEST");
      expect(text).not.toContain("THE REAL FIX");
      expect(text).not.toContain("FAIL_TO_PASS");
    }
    expect(Object.keys(all[0] ?? {}).sort()).toEqual([
      "baseCommit",
      "instanceId",
      "problemStatement",
      "repo",
    ]);
  });

  it("uses the cache on the second call, and reads again on refresh", async () => {
    const cacheDir = await tmp();
    const server = datasetServer();
    await loadSweLite({ fetch: asFetch(server), cacheDir });
    await loadSweLite({ fetch: asFetch(server), cacheDir });
    expect(server).toHaveBeenCalledTimes(3);
    await loadSweLite({ fetch: asFetch(server), cacheDir, refresh: true });
    expect(server).toHaveBeenCalledTimes(6);
  });

  it("ignores a damaged cache file", async () => {
    const cacheDir = await tmp();
    await loadSweLite({ fetch: asFetch(datasetServer()), cacheDir });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(cacheDir, "swebench-lite.json"), "{half a fi");
    const server = datasetServer();
    const all = await loadSweLite({ fetch: asFetch(server), cacheDir });
    expect(all).toHaveLength(ROWS);
    expect(server).toHaveBeenCalled();
  });

  it("refuses a short read instead of caching it", async () => {
    const cacheDir = await tmp();
    const short = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ num_rows_total: 300, rows: [row(0)] }))),
    );
    // Page one has 1 of 300 rows and page two is empty: the list is incomplete.
    short.mockResolvedValueOnce(
      new Response(JSON.stringify({ num_rows_total: 300, rows: [row(0)] })),
    );
    short.mockResolvedValueOnce(new Response(JSON.stringify({ num_rows_total: 300, rows: [] })));
    await expect(
      loadSweLite({ fetch: short as unknown as typeof fetch, cacheDir }),
    ).rejects.toThrow(/Read 1 of 300/);
    await expect(readFile(join(cacheDir, "swebench-lite.json"), "utf8")).rejects.toThrow();
  });

  it("retries a server error and gives up on a client error", async () => {
    const cacheDir = await tmp();
    const flaky = datasetServer(5);
    flaky.mockImplementationOnce(() => Promise.resolve(new Response("busy", { status: 503 })));
    const all = await loadSweLite({ fetch: asFetch(flaky), cacheDir, retry: noWait });
    expect(all).toHaveLength(5);

    const forbidden = vi.fn(() => Promise.resolve(new Response("no", { status: 401 })));
    const err = await loadSweLite({
      fetch: forbidden as unknown as typeof fetch,
      cacheDir: await tmp(),
      retry: noWait,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatasetError);
    expect((err as Error).message).toContain("HTTP 401");
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it("rejects rows that are not in the expected shape", async () => {
    const bad = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            num_rows_total: 1,
            rows: [{ row: { instance_id: "a__b-1", repo: "a/b", base_commit: "main" } }],
          }),
        ),
      ),
    );
    await expect(
      loadSweLite({ fetch: bad as unknown as typeof fetch, cacheDir: await tmp() }),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe("sampleInstances", () => {
  const all: SweInstance[] = Array.from({ length: 50 }, (_, i) => ({
    instanceId: `o__r-${String(i).padStart(3, "0")}`,
    repo: "o/r",
    baseCommit: SHA,
    problemStatement: "x",
  }));
  const ids = (xs: SweInstance[]): string[] => xs.map((x) => x.instanceId);

  it("gives the same sample for the same seed, however the input is ordered", () => {
    const a = sampleInstances(all, 10, 42);
    const b = sampleInstances([...all].reverse(), 10, 42);
    expect(ids(a)).toEqual(ids(b));
    expect(a).toHaveLength(10);
  });

  it("gives other samples for other seeds", () => {
    expect(ids(sampleInstances(all, 10, 1))).not.toEqual(ids(sampleInstances(all, 10, 2)));
  });

  it("returns a sorted sample of distinct instances", () => {
    const sample = ids(sampleInstances(all, 20, 7));
    expect(sample).toEqual([...sample].sort());
    expect(new Set(sample).size).toBe(20);
  });

  it("handles a sample larger than the set, and zero", () => {
    expect(sampleInstances(all, 500, 1)).toHaveLength(50);
    expect(sampleInstances(all, 0, 1)).toEqual([]);
  });

  it("does not change the input", () => {
    const before = ids(all);
    sampleInstances(all, 10, 3);
    expect(ids(all)).toEqual(before);
  });
});

describe("renderSweIssue", () => {
  it("shows the id, the repo and the problem statement, and nothing else", () => {
    const text = renderSweIssue({
      instanceId: "o__r-1",
      repo: "o/r",
      baseCommit: SHA,
      problemStatement: "It breaks.",
    });
    expect(text).toBe("# o__r-1\no/r\n\nIt breaks.");
  });
});
