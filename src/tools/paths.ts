import { posix } from "node:path";
import { REPO_DIR } from "../sandbox/images.js";

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Resolve a tool-supplied path to an absolute path inside /repo.
 * Relative paths are taken relative to /repo. Throws `PathError` for anything that lands outside.
 *
 * This is a lexical check. The container is the real isolation boundary, so this guard exists to
 * give the model a clear error instead of a confusing permission failure.
 */
export function resolveRepoPath(path: string): string {
  if (path === "") throw new PathError("Path must not be empty.");
  if (path.includes("\0")) throw new PathError("Path must not contain NUL bytes.");

  const resolved = posix.resolve(REPO_DIR, path);
  if (resolved !== REPO_DIR && !resolved.startsWith(`${REPO_DIR}/`)) {
    throw new PathError(
      `Path "${path}" is outside ${REPO_DIR}. Only files inside ${REPO_DIR} can be used.`,
    );
  }
  return resolved;
}
