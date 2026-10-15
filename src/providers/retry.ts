export interface RetryOptions {
  /** Total attempts including the first. Spec: max 5 tries. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for tests. */
  sleep: (ms: number) => Promise<void>;
  /** Returns a value in [0, 1). Injected for tests. */
  random: () => number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** HTTP status carried by vendor SDK errors, if any. */
function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    return typeof err.status === "number" ? err.status : undefined;
  }
  return undefined;
}

/** Retry on rate limits (429) and server errors (5xx). Everything else fails fast. */
export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && (status === 429 || status >= 500);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const o = { ...DEFAULT_RETRY, ...opts };
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= o.maxAttempts || !isRetryable(err)) throw err;
      const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
      // Full jitter: random delay in (0, exp].
      await o.sleep(Math.max(1, Math.round(exp * o.random())));
    }
  }
}
