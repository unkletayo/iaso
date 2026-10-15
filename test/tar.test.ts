import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTar, tarDirectory, tarOwnerFlags } from "../src/sandbox/tar.js";

function listWithHostTar(archive: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "iaso-tar-"));
  const file = join(dir, "a.tar");
  writeFileSync(file, archive);
  return execFileSync("tar", ["-tvf", file], { encoding: "utf8" });
}

describe("makeTar", () => {
  it("produces an archive the host tar can read", () => {
    const listing = listWithHostTar(
      makeTar([
        { name: "repo/", mode: 0o755, uid: 1000, gid: 1000 },
        { name: "hello.txt", content: Buffer.from("hi there"), mode: 0o644, uid: 1000, gid: 1000 },
      ]),
    );
    expect(listing).toContain("repo/");
    expect(listing).toContain("hello.txt");
    expect(listing).toMatch(/1000\s+1000\s+8\s/);
  });

  it("pads content to 512-byte blocks and ends with two zero blocks", () => {
    const tar = makeTar([{ name: "f", content: Buffer.from("x"), mode: 0o644, uid: 0, gid: 0 }]);
    expect(tar.length).toBe(512 + 512 + 1024);
  });

  it("handles empty files and multi-block files", () => {
    const big = Buffer.alloc(1500, "a");
    const listing = listWithHostTar(
      makeTar([
        { name: "empty", content: Buffer.alloc(0), mode: 0o644, uid: 1, gid: 1 },
        { name: "big", content: big, mode: 0o600, uid: 1, gid: 1 },
      ]),
    );
    expect(listing).toMatch(/\s0\s.*empty/);
    expect(listing).toMatch(/\s1500\s.*big/);
  });

  it("rejects names over 100 bytes", () => {
    expect(() =>
      makeTar([{ name: "a".repeat(101), content: Buffer.alloc(0), mode: 0o644, uid: 0, gid: 0 }]),
    ).toThrow(/too long/);
  });
});

describe("tarOwnerFlags", () => {
  it("uses --uid/--gid for bsdtar and --owner/--group for GNU tar", () => {
    expect(tarOwnerFlags("bsdtar 3.5.3 - libarchive", 1000, 1000)).toEqual([
      "--uid",
      "1000",
      "--gid",
      "1000",
    ]);
    expect(tarOwnerFlags("tar (GNU tar) 1.35", 1000, 1000)).toEqual([
      "--owner=1000",
      "--group=1000",
      "--numeric-owner",
    ]);
  });
});

describe("tarDirectory", () => {
  it("streams a directory owned by the requested uid, skipping node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iaso-src-"));
    writeFileSync(join(dir, "a.txt"), "A");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.js"), "x");
    mkdirSync(join(dir, "sub", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "sub", "node_modules", "dep2.js"), "x");
    writeFileSync(join(dir, "sub", "b.txt"), "B");

    const { stream, done } = tarDirectory(dir, 1000, 1000);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    await done;

    const listing = listWithHostTar(Buffer.concat(chunks));
    expect(listing).toContain("a.txt");
    expect(listing).toContain("sub/b.txt");
    expect(listing).not.toContain("node_modules");
    expect(listing).toMatch(/1000\s+1000/);
  });
});
