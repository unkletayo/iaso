/**
 * Helper process for docker.integration.test.ts. Starts a real sandbox, prints
 * "READY <container-name>", then either crashes ("throw") or waits to be signalled ("wait").
 * Usage: tsx crash-child.ts <runId> <throw|wait>
 */
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { containerName } from "../../src/sandbox/images.js";

const [runId, mode] = process.argv.slice(2);
if (runId === undefined || (mode !== "throw" && mode !== "wait")) {
  console.error("usage: crash-child.ts <runId> <throw|wait>");
  process.exit(2);
}

const sandbox = new DockerSandbox({ runId });
try {
  await sandbox.start();
  console.log(`READY ${containerName(runId)}`);
  if (mode === "throw") throw new Error("simulated crash");
  // Wait for a signal. The timer keeps the event loop alive: without it Node exits with code 13
  // ("unsettled top-level await") before any signal arrives.
  const keepAlive = setInterval(() => undefined, 1000);
  await new Promise<void>(() => undefined);
  clearInterval(keepAlive);
} finally {
  await sandbox.destroy();
}
