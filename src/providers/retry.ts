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

/**
 * A stream that failed after part of the answer had already been handed out. Retrying would hand
 * out the beginning twice, so this must never be retried: it carries no HTTP status, whatever the
 * cause had, and `isRetryable` only retries on a status.
 */
export class StreamInterruptedError extends Error {
  constructor(cause: unknown) {
    super(
      `The stream broke after it started: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "StreamInterruptedError";
    this.cause = cause;
  }
}

/** Retry on rate limits (429) and server errors (5xx). Everything else fails fast. */
export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  return status !== undefined && (status === 429 || status >= 500);
}

/** An aborted `signal` stops the retries: no new attempt starts after it fires. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
  signal?: AbortSignal,
): Promise<T> {
  const o = { ...DEFAULT_RETRY, ...opts };
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (attempt >= o.maxAttempts || !isRetryable(err) || signal?.aborted === true) throw err;
      const exp = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** (attempt - 1));
      // Full jitter: random delay in (0, exp].
      await o.sleep(Math.max(1, Math.round(exp * o.random())));
    }
  }
}
