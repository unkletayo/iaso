import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { cleanupAll, installSignalHandlers, registerForCleanup } from "../src/sandbox/cleanup.js";

describe("cleanupAll", () => {
  it("destroys every registered item once", async () => {
    const a = { destroy: vi.fn(() => Promise.resolve()) };
    const b = { destroy: vi.fn(() => Promise.resolve()) };
    registerForCleanup(a);
    registerForCleanup(b);
    expect(await cleanupAll()).toEqual([]);
    expect(a.destroy).toHaveBeenCalledTimes(1);
    expect(b.destroy).toHaveBeenCalledTimes(1);
    await cleanupAll();
    expect(a.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips items that were unregistered", async () => {
    const a = { destroy: vi.fn(() => Promise.resolve()) };
    registerForCleanup(a)();
    await cleanupAll();
    expect(a.destroy).not.toHaveBeenCalled();
  });

  it("keeps going when one destroy fails and reports the error", async () => {
    const bad = { destroy: vi.fn(() => Promise.reject(new Error("boom"))) };
    const good = { destroy: vi.fn(() => Promise.resolve()) };
    registerForCleanup(bad);
    registerForCleanup(good);
    const errors = await cleanupAll();
    expect(errors.map((e) => e.message)).toEqual(["boom"]);
    expect(good.destroy).toHaveBeenCalled();
  });
});

describe("installSignalHandlers", () => {
  it("cleans up then exits 130 on SIGINT", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const item = { destroy: vi.fn(() => Promise.resolve()) };
    registerForCleanup(item);
    installSignalHandlers(target, exit);

    target.emit("SIGINT");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(130);
    });
    expect(item.destroy).toHaveBeenCalledTimes(1);
  });

  it("exits 143 on SIGTERM", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    installSignalHandlers(target, exit);
    target.emit("SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(143);
    });
  });

  it("exits immediately on a second signal while cleanup is still running", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const stuck = { destroy: vi.fn(() => new Promise<void>(() => undefined)) };
    registerForCleanup(stuck);
    installSignalHandlers(target, exit);

    target.emit("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    target.emit("SIGINT");
    expect(exit).toHaveBeenCalledWith(130);
    await cleanupAll().catch(() => undefined);
  });

  it("removes its handlers when asked", () => {
    const target = new EventEmitter();
    const uninstall = installSignalHandlers(target, vi.fn());
    expect(target.listenerCount("SIGINT")).toBe(1);
    uninstall();
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
