import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Source } from "./types.js";

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `--repo <path> --issue <file>`: nothing is created, so nothing is cleaned up. */
export async function localSource(o: { repo: string; issue: string }): Promise<Source> {
  const repoPath = resolve(o.repo);
  const issuePath = resolve(o.issue);
  if (!(await isDirectory(repoPath))) {
    throw new SourceError(`--repo is not a folder: ${repoPath}`);
  }
  let issue: string;
  try {
    issue = await readFile(issuePath, "utf8");
  } catch {
    throw new SourceError(`Cannot read the issue file: ${issuePath}`);
  }
  if (issue.trim() === "") throw new SourceError(`The issue file is empty: ${issuePath}`);
  return { repoPath, issue, label: repoPath, cleanup: () => Promise.resolve() };
}
