export type Language = "node" | "python" | "java" | "go";

/**
 * Base images per language. Java and Go are basic for now: JDK 21 + Maven + Gradle images and
 * version detection arrive with environment detection (M9).
 */
const BASE_IMAGES: Record<Language, string> = {
  node: "node:22-bookworm",
  python: "python:3.12-bookworm",
  java: "eclipse-temurin:21-jdk",
  go: "golang:1.23-bookworm",
};

/** Used when the language is unknown. Includes git and a uid 1000 user. */
export const DEFAULT_IMAGE = BASE_IMAGES.node;

export function baseImageFor(language: Language): string {
  return BASE_IMAGES[language];
}

/** Hard limits from the spec (§6). */
export const SANDBOX_LIMITS = {
  cpus: 2,
  memoryBytes: 4 * 1024 ** 3,
  pids: 1024,
} as const;

/** Non-root user the agent runs as. */
export const SANDBOX_USER = "1000:1000";

/** Where the repo lives inside the container. */
export const REPO_DIR = "/repo";

export const CONTAINER_LABEL = "iaso.run";

export function containerName(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) {
    throw new Error(`Invalid run id "${runId}": use letters, digits, "_", "." and "-" only.`);
  }
  return `iaso-${runId}`;
}
