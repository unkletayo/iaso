import { describe, expect, it, vi } from "vitest";
import {
  INSTALL_TIMEOUT_SEC,
  InstallError,
  describeNetwork,
  installThenCutNetwork,
} from "../src/sandbox/install.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

function setup(result = { exitCode: 0, stdout: "", stderr: "", timedOut: false }) {
  const fake = fakeSandbox({}, () => result);
  const setNetwork = vi.fn(() => Promise.resolve());
  fake.sandbox.setNetwork = setNetwork;
  return { ...fake, setNetwork, log: vi.fn() };
}

describe("installThenCutNetwork", () => {
  it("leaves the network on and runs nothing without an install command", async () => {
    const s = setup();
    const state = await installThenCutNetwork(s.sandbox, undefined, s.log);
    expect(state).toEqual({ network: "on", reason: "no installCommand in .iaso.json" });
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.setNetwork).not.toHaveBeenCalled();
  });

  it("installs with the network on, then turns it off", async () => {
    const s = setup();
    const order: string[] = [];
    s.exec.mockImplementation(() => {
      order.push("install");
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    });
    s.setNetwork.mockImplementation(() => {
      order.push("offline");
      return Promise.resolve();
    });
    const state = await installThenCutNetwork(s.sandbox, "npm ci", s.log);
    expect(state).toEqual({ network: "off", installCommand: "npm ci" });
    expect(s.exec).toHaveBeenCalledWith("npm ci", { timeoutSec: INSTALL_TIMEOUT_SEC });
    expect(s.setNetwork).toHaveBeenCalledWith(false);
    expect(order).toEqual(["install", "offline"]);
  });

  it("stops with the end of the output when the install fails, and keeps the network as it was", async () => {
    const s = setup({
      exitCode: 1,
      stdout: "",
      stderr: "npm ERR! missing lockfile",
      timedOut: false,
    });
    const err = await installThenCutNetwork(s.sandbox, "npm ci", s.log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InstallError);
    expect((err as Error).message).toContain("The install command failed (exit 1): npm ci");
    expect((err as Error).message).toContain("npm ERR! missing lockfile");
    expect(s.setNetwork).not.toHaveBeenCalled();
  });

  it("treats a timed-out install as a failure", async () => {
    const s = setup({ exitCode: 124, stdout: "", stderr: "", timedOut: true });
    await expect(installThenCutNetwork(s.sandbox, "pip install -e .", s.log)).rejects.toThrow(
      `timed out after ${String(INSTALL_TIMEOUT_SEC)}s`,
    );
  });
});

describe("describeNetwork", () => {
  it("says what happened in one line", () => {
    expect(describeNetwork({ network: "off", installCommand: "npm ci" })).toBe(
      "off after `npm ci`",
    );
    expect(describeNetwork({ network: "on", reason: "no installCommand in .iaso.json" })).toBe(
      "on for the whole run (no installCommand in .iaso.json)",
    );
  });
});
