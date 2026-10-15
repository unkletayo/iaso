import { describe, expect, it, vi } from "vitest";
import { isRetryable, withRetry } from "../src/providers/retry.js";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${String(status)}`);
  }
}

const fast = { sleep: () => Promise.resolve(), random: () => 0.5 };

describe("isRetryable", () => {
  it("retries 429 and 5xx only", () => {
    expect(isRetryable(new HttpError(429))).toBe(true);
    expect(isRetryable(new HttpError(500))).toBe(true);
    expect(isRetryable(new HttpError(503))).toBe(true);
    expect(isRetryable(new HttpError(400))).toBe(false);
    expect(isRetryable(new HttpError(401))).toBe(false);
    expect(isRetryable(new Error("no status"))).toBe(false);
    expect(isRetryable("string")).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    expect(await withRetry(() => Promise.resolve("ok"), { ...fast, sleep })).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable error then succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(429))
      .mockRejectedValueOnce(new HttpError(500))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, fast)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after 5 attempts and throws the last error", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError(503));
    await expect(withRetry(fn, fast)).rejects.toThrow("http 503");
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError(401));
    await expect(withRetry(fn, fast)).rejects.toThrow("http 401");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off exponentially, capped by maxDelayMs", async () => {
    const delays: number[] = [];
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new HttpError(500));
    await expect(
      withRetry(fn, {
        baseDelayMs: 100,
        maxDelayMs: 350,
        random: () => 1,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200, 350, 350]);
  });
});
