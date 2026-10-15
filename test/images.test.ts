import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE,
  SANDBOX_LIMITS,
  baseImageFor,
  containerName,
} from "../src/sandbox/images.js";

describe("images", () => {
  it("maps every language to an image and defaults to node", () => {
    expect(baseImageFor("python")).toMatch(/^python:/);
    expect(baseImageFor("java")).toMatch(/temurin/);
    expect(baseImageFor("go")).toMatch(/^golang:/);
    expect(DEFAULT_IMAGE).toBe(baseImageFor("node"));
  });

  it("matches the spec limits", () => {
    expect(SANDBOX_LIMITS).toEqual({ cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 1024 });
  });
});

describe("containerName", () => {
  it("prefixes the run id with iaso-", () => {
    expect(containerName("abc-123_x.y")).toBe("iaso-abc-123_x.y");
  });

  it("rejects ids that are unsafe as container names", () => {
    for (const bad of ["", "-lead", "a b", "a/b", "a;rm", "é"]) {
      expect(() => containerName(bad)).toThrow(/Invalid run id/);
    }
  });
});
