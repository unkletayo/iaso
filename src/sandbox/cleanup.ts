export interface Destroyable {
  destroy(): Promise<void>;
}

/** The slice of `process` the signal handlers need. Injected in tests. */
export interface SignalTarget {
  on(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
}

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

const live = new Set<Destroyable>();

/** Track a sandbox so a signal can tear it down. Returns an unregister function. */
export function registerForCleanup(item: Destroyable): () => void {
  live.add(item);
  return () => {
    live.delete(item);
  };
}

/** Destroy everything registered. Never throws: returns the errors that happened. */
export async function cleanupAll(): Promise<Error[]> {
  const items = [...live];
  live.clear();
  const results = await Promise.allSettled(items.map((item) => item.destroy()));
  return results.flatMap((r) =>
    r.status === "rejected"
      ? [r.reason instanceof Error ? r.reason : new Error(String(r.reason))]
      : [],
  );
}

/**
 * On SIGINT/SIGTERM destroy all registered sandboxes, then exit with 128+signal.
 * A second signal exits immediately. Returns a function that removes the handlers.
 */
export function installSignalHandlers(
  target: SignalTarget = process,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let shuttingDown = false;
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]).map(
    (signal) => {
      const code = SIGNAL_EXIT_CODES[signal];
      const listener = (): void => {
        if (shuttingDown) {
          exit(code);
          return;
        }
        shuttingDown = true;
        void cleanupAll().finally(() => {
          exit(code);
        });
      };
      target.on(signal, listener);
      return { signal, listener };
    },
  );
  return () => {
    for (const { signal, listener } of handlers) target.off(signal, listener);
  };
}
