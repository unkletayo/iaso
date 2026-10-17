import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DockerSandbox } from "../../src/sandbox/docker.js";
import { SWEBENCH_REPO, instanceImage, setupScript } from "../../src/sandbox/prebuilt.js";

/**
 * A real SWE-bench instance image (about 1 GB, pulled on first use) in the real sandbox.
 * Free. Opt in with: IASO_DOCKER=1 npx vitest run test/integration/prebuilt
 */
const enabled = process.env.IASO_DOCKER === "1";
const IMAGE = instanceImage("psf__requests-3362");
const run = promisify(execFile);

describe.skipIf(!enabled)("prebuilt repo in a SWE-bench instance image", () => {
  it(
    "deletes commits that only other refs reach, and keeps the ones HEAD reaches",
    { timeout: 20 * 60_000 },
    async () => {
      // The same capability set the sandbox gives the setup step: all dropped except CHOWN.
      const script = [
        "set -e",
        "cd /testbed",
        "git config --global --add safe.directory /testbed",
        "git config user.email t@example.com && git config user.name t",
        // Make a commit in the "future": only a branch and a tag reach it.
        "git checkout -q -b future",
        "echo SECRET-FIX > fix.txt && git add fix.txt && git commit -q -m 'the real fix'",
        "git tag v99",
        "sha=$(git rev-parse HEAD)",
        "git checkout -q main",
        "before=$(git rev-list HEAD | wc -l)",
        setupScript("/testbed"),
        'if git cat-file -e "$sha" 2>/dev/null; then echo LEAK; else echo GONE; fi',
        'echo "refs=$(git for-each-ref | wc -l)"',
        'echo "same=$([ "$before" = "$(git rev-list --all | wc -l)" ] && echo yes || echo no)"',
        "ls -ld /repo | cut -c1",
      ].join("\n");
      await run("docker", ["pull", "-q", IMAGE], { timeout: 15 * 60_000 });
      const { stdout } = await run(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          IMAGE,
          "bash",
          "-c",
          script,
        ],
        { timeout: 5 * 60_000 },
      );
      expect(stdout).toContain("GONE");
      expect(stdout).not.toContain("LEAK");
      expect(stdout).toContain("refs=0");
      expect(stdout).toContain("same=yes");
      expect(stdout).toMatch(/^l$/m);
    },
  );

  it(
    "gives the agent a working non-root sandbox on /repo with the repo's own Python",
    { timeout: 20 * 60_000 },
    async () => {
      const sandbox = new DockerSandbox({
        runId: `prebuilt-${String(Date.now())}`,
        image: IMAGE,
        prebuilt: SWEBENCH_REPO,
      });
      await sandbox.start();
      try {
        await sandbox.setNetwork(false);
        const sh = async (cmd: string) => {
          const res = await sandbox.exec(cmd);
          return { ...res, out: res.stdout.trim() };
        };

        expect((await sh("id -u")).out).toBe("1000");
        expect((await sh("readlink /repo")).out).toBe("/testbed");
        expect((await sh("python --version 2>&1")).out).toContain("Python 3.9");
        expect((await sh("which pytest")).out).toBe("/opt/miniconda3/envs/testbed/bin/pytest");

        // History: nothing outside what the agent can already see.
        expect((await sh("git rev-list --all | wc -l")).out).toBe(
          (await sh("git rev-list HEAD | wc -l")).out,
        );
        expect((await sh("git tag")).out).toBe("iaso-baseline");

        // The repo's own tests run, offline, as the agent would run them.
        const tests = await sh(
          'python -m pytest tests/test_requests.py -q -p no:cacheprovider -k "test_params_are_added_before_fragment or test_header_keys_are_native" 2>&1 | tail -1',
        );
        expect(tests.out).toMatch(/2 passed/);

        // The agent can edit through the /repo path, and the diff shows exactly that edit.
        expect(await sandbox.diff()).toBe("");
        const api = await sandbox.readFile("/repo/requests/api.py");
        await sandbox.writeFile("/repo/requests/api.py", `${api}\n# edited by the agent\n`);
        const diff = await sandbox.diff();
        expect(diff).toContain("+# edited by the agent");
        expect(diff.match(/^diff --git/gm)).toHaveLength(1);
        expect(diff).toContain("a/requests/api.py");
      } finally {
        await sandbox.destroy();
      }
    },
  );
});
