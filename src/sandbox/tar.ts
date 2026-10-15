import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface TarEntry {
  /** Path inside the archive (max 100 bytes). Directories must end with "/". */
  name: string;
  /** File content. Omit for directories. */
  content?: Buffer;
  mode: number;
  uid: number;
  gid: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

function header(entry: TarEntry): Buffer {
  const isDir = entry.name.endsWith("/");
  if (Buffer.byteLength(entry.name) > 100) {
    throw new Error(`tar entry name too long (max 100 bytes): ${entry.name}`);
  }
  const h = Buffer.alloc(BLOCK);
  h.write(entry.name, 0, 100, "utf8");
  h.write(`${octal(entry.mode, 7)}\0`, 100);
  h.write(`${octal(entry.uid, 7)}\0`, 108);
  h.write(`${octal(entry.gid, 7)}\0`, 116);
  h.write(`${octal(isDir ? 0 : (entry.content?.length ?? 0), 11)}\0`, 124);
  h.write(`${octal(Math.floor(Date.now() / 1000), 11)}\0`, 136);
  h.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  h.write(isDir ? "5" : "0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${octal(sum, 6)}\0 `, 148);
  return h;
}

/** Build a minimal POSIX ustar archive in memory (files and directories only). */
export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    const content = entry.name.endsWith("/") ? undefined : entry.content;
    if (content && content.length > 0) {
      parts.push(content);
      const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
      if (pad > 0) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  return Buffer.concat(parts);
}

/** bsdtar (macOS) and GNU tar spell the "force owner" flags differently. */
export function tarOwnerFlags(versionOutput: string, uid: number, gid: number): string[] {
  return versionOutput.includes("bsdtar")
    ? ["--uid", String(uid), "--gid", String(gid)]
    : [`--owner=${String(uid)}`, `--group=${String(gid)}`, "--numeric-owner"];
}

/**
 * Drop extended attributes. macOS tags files with `com.apple.provenance`, and the Docker daemon
 * fails the whole extraction ("lsetxattr ... operation not supported") when it meets one.
 */
export function tarSanitizeFlags(versionOutput: string): string[] {
  return versionOutput.includes("bsdtar") ? ["--no-xattrs", "--no-mac-metadata"] : ["--no-xattrs"];
}

export interface HostTar {
  stream: Readable;
  /** Resolves when tar exits 0; rejects with tar's stderr otherwise. */
  done: Promise<void>;
}

/**
 * Stream a host directory as a tar with every file owned by uid:gid.
 * `node_modules` is skipped at any depth: dependencies are installed inside the container.
 */
export function tarDirectory(dir: string, uid: number, gid: number): HostTar {
  const version = execFileSync("tar", ["--version"], { encoding: "utf8" });
  const child: ChildProcess = spawn(
    "tar",
    [
      ...tarOwnerFlags(version, uid, gid),
      ...tarSanitizeFlags(version),
      "--exclude=node_modules",
      "-cf",
      "-",
      "-C",
      dir,
      ".",
    ],
    // COPYFILE_DISABLE stops macOS tar from adding AppleDouble "._" files.
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (!child.stdout || !child.stderr) throw new Error("tar: missing stdio streams");

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${String(code)}: ${stderr.trim()}`));
    });
  });
  // The caller may only await `done` after the stream ends; avoid an unhandled rejection meanwhile.
  done.catch(() => undefined);
  return { stream: child.stdout, done };
}
