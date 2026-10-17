import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withRetry } from "../providers/retry.js";

const DATASET = "princeton-nlp/SWE-bench_Lite";
const ROWS_API = "https://datasets-server.huggingface.co/rows";
/** The most rows the datasets server returns per request. */
const PAGE_SIZE = 100;

/**
 * What a benchmark run may know about an instance. The dataset also has `test_patch`,
 * `FAIL_TO_PASS`, `PASS_TO_PASS` and `patch` (the real fix). They are dropped on read, so they
 * cannot reach the agent, the cache file or a log by mistake. The official harness reads them
 * from the dataset itself.
 */
export interface SweInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
  problemStatement: string;
}

/** The dataset could not be read, or it is not what we expect. `status` lets `withRetry` retry. */
export class DatasetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DatasetError";
  }
}

const rowsPage = z.object({
  num_rows_total: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      row: z.object({
        instance_id: z.string().min(1),
        repo: z.string().min(1),
        base_commit: z.string().regex(/^[0-9a-f]{40}$/),
        problem_statement: z.string().min(1),
      }),
    }),
  ),
});

export interface LoadOptions {
  fetch?: typeof fetch;
  /** Where the instance list is kept. Default: `~/.iaso/cache`. */
  cacheDir?: string;
  /** Ignore the cached list and read the dataset again. */
  refresh?: boolean;
  /** Retry options for tests. */
  retry?: Parameters<typeof withRetry>[1];
}

const byId = (a: SweInstance, b: SweInstance): number =>
  a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0;

const cacheFile = (o: LoadOptions): string =>
  join(o.cacheDir ?? join(homedir(), ".iaso", "cache"), "swebench-lite.json");

const cacheSchema = z.array(
  z.object({
    instanceId: z.string(),
    repo: z.string(),
    baseCommit: z.string(),
    problemStatement: z.string(),
  }),
);

async function readCache(path: string): Promise<SweInstance[] | undefined> {
  try {
    return cacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // Missing or damaged: read the dataset again.
    return undefined;
  }
}

async function fetchPage(offset: number, o: LoadOptions): Promise<z.infer<typeof rowsPage>> {
  const doFetch = o.fetch ?? fetch;
  const url =
    `${ROWS_API}?dataset=${encodeURIComponent(DATASET)}&config=default&split=test` +
    `&offset=${String(offset)}&length=${String(PAGE_SIZE)}`;
  return withRetry(async () => {
    const res = await doFetch(url, { headers: { "User-Agent": "iaso" } });
    if (!res.ok) {
      throw new DatasetError(
        `Could not read ${DATASET} (HTTP ${String(res.status)}) at offset ${String(offset)}.`,
        res.status,
      );
    }
    const parsed = rowsPage.safeParse(await res.json());
    if (!parsed.success) {
      throw new DatasetError(
        `${DATASET} returned rows in an unexpected shape: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data;
  }, o.retry);
}

/**
 * All instances of the SWE-bench Lite test split, sorted by id. The list is cached, so only the
 * first run needs the network.
 */
export async function loadSweLite(o: LoadOptions = {}): Promise<SweInstance[]> {
  const path = cacheFile(o);
  if (!o.refresh) {
    const cached = await readCache(path);
    if (cached) return cached;
  }

  const all: SweInstance[] = [];
  let total = Number.POSITIVE_INFINITY;
  while (all.length < total) {
    const page = await fetchPage(all.length, o);
    total = page.num_rows_total;
    if (page.rows.length === 0) break;
    for (const { row } of page.rows) {
      all.push({
        instanceId: row.instance_id,
        repo: row.repo,
        baseCommit: row.base_commit,
        problemStatement: row.problem_statement,
      });
    }
  }
  if (all.length !== total || total === 0) {
    throw new DatasetError(
      `Read ${String(all.length)} of ${String(total)} instances from ${DATASET}. Try again.`,
    );
  }
  all.sort(byId);

  // Write to a temp name first so a crash cannot leave half a file that later parses as short.
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(all), "utf8");
  await rename(tmp, path);
  return all;
}

/** A small, fast, seedable generator (mulberry32). Not for security. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` instances picked by `seed`. The input is sorted by id first, so the same seed gives the same
 * sample whatever order the dataset arrives in. The result is sorted by id, which keeps `--resume`
 * and the results table stable.
 */
export function sampleInstances(
  all: readonly SweInstance[],
  n: number,
  seed: number,
): SweInstance[] {
  const sorted = [...all].sort(byId);
  const random = seeded(seed);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j] as SweInstance, sorted[i] as SweInstance];
  }
  return sorted.slice(0, Math.max(0, n)).sort(byId);
}

/** The bug report the agent gets: the problem statement under a short header. */
export function renderSweIssue(instance: SweInstance): string {
  return `# ${instance.instanceId}\n${instance.repo}\n\n${instance.problemStatement}`;
}
