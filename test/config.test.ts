import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("applies defaults to an empty object", () => {
    expect(parseConfig("{}", "x")).toEqual({ extraRules: [], services: [] });
  });

  it("accepts a full config", () => {
    const cfg = parseConfig(
      JSON.stringify({
        image: "node:22",
        installCommand: "npm ci",
        testCommand: "npm test",
        relatedTestsPattern: "npx vitest run {files}",
        extraRules: ["Use tabs"],
        services: [{ name: "db", image: "postgres:16", env: { A: "b" }, ports: [5432] }],
      }),
      "x",
    );
    expect(cfg.services[0]?.ports).toEqual([5432]);
  });

  it("rejects unknown keys", () => {
    expect(() => parseConfig('{"bogus":1}', "x")).toThrow(ConfigError);
  });

  it("rejects invalid JSON with the file path in the message", () => {
    expect(() => parseConfig("{", "/p/.iaso.json")).toThrow(/\/p\/\.iaso\.json: invalid JSON/);
  });

  it("rejects wrong types", () => {
    expect(() => parseConfig('{"testCommand":""}', "x")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("returns defaults when the default file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "iaso-cfg-"));
    expect(loadConfig(dir)).toEqual({ extraRules: [], services: [] });
  });

  it("reads .iaso.json from the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "iaso-cfg-"));
    writeFileSync(join(dir, ".iaso.json"), '{"testCommand":"make test"}');
    expect(loadConfig(dir).testCommand).toBe("make test");
  });

  it("throws when an explicit config path is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "iaso-cfg-"));
    expect(() => loadConfig(dir, join(dir, "nope.json"))).toThrow(ConfigError);
  });
});
