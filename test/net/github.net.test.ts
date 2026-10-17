import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { githubSource } from "../../src/sources/github.js";

/**
 * Reads a real public issue and clones its repo from github.com. Free, but needs the network and
 * is subject to GitHub's rate limit (a GITHUB_TOKEN in the environment raises it).
 * Opt in with: IASO_NET=1 npx vitest run test/net
 */
const ISSUE_URL = "https://github.com/wassim-azi/agy-powerline/issues/46";

describe("githubSource against github.com", () => {
  it(
    "fetches the issue, clones the repo and leaves no credentials behind",
    {
      timeout: 120_000,
    },
    async () => {
      const token = process.env.GITHUB_TOKEN;
      const src = await githubSource(ISSUE_URL, token ? { token } : {});
      try {
        expect(src.label).toBe("wassim-azi/agy-powerline#46");
        expect(src.issueUrl).toBe(ISSUE_URL);
        expect(src.issue).toContain("clock");
        expect(src.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(existsSync(join(src.repoPath, "package.json"))).toBe(true);

        const gitConfig = await readFile(join(src.repoPath, ".git", "config"), "utf8");
        expect(gitConfig).not.toMatch(/extraheader|authorization/i);
        if (token) expect(gitConfig).not.toContain(token);
      } finally {
        await src.cleanup();
      }
      expect(existsSync(src.repoPath)).toBe(false);
    },
  );
});
