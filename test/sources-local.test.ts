import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SourceError, localSource } from "../src/sources/local.js";

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "iaso-local-"));
  await mkdir(join(dir, "repo"));
  await writeFile(join(dir, "issue.md"), "the bug\n");
  return { repo: join(dir, "repo"), issue: join(dir, "issue.md"), dir };
}

describe("localSource", () => {
  it("reads the issue and points at the repo folder", async () => {
    const w = await workspace();
    const src = await localSource(w);
    expect(src.repoPath).toBe(w.repo);
    expect(src.issue).toBe("the bug\n");
    expect(src.label).toBe(w.repo);
    expect(src.issueUrl).toBeUndefined();
    await expect(src.cleanup()).resolves.toBeUndefined();
  });

  it("names the problem when the repo or the issue is wrong", async () => {
    const w = await workspace();
    await expect(localSource({ ...w, repo: join(w.dir, "missing") })).rejects.toThrow(
      /--repo is not a folder/,
    );
    await expect(localSource({ ...w, repo: w.issue })).rejects.toThrow(SourceError);
    await expect(localSource({ ...w, issue: join(w.dir, "nope.md") })).rejects.toThrow(
      /Cannot read the issue file/,
    );
    await writeFile(join(w.dir, "empty.md"), "  \n");
    await expect(localSource({ ...w, issue: join(w.dir, "empty.md") })).rejects.toThrow(/empty/);
  });
});
