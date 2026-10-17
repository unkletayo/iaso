import { SANDBOX_USER } from "./images.js";

/** A repository that is already inside the image, set up and ready to test (SWE-bench instances). */
export interface PrebuiltRepo {
  /** Where the image keeps the repository. It is made available as `/repo` too. */
  dir: string;
  /** Container environment, e.g. to put the repo's own Python environment first on `PATH`. */
  env: readonly string[];
}

/** SWE-bench instance images keep the repo in `/testbed` and its dependencies in a conda env. */
export const SWEBENCH_REPO: PrebuiltRepo = {
  dir: "/testbed",
  env: [
    "PATH=/opt/miniconda3/envs/testbed/bin:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "CONDA_PREFIX=/opt/miniconda3/envs/testbed",
    "CONDA_DEFAULT_ENV=testbed",
  ],
};

/** The official per-instance image: `owner__repo-123` becomes `owner_1776_repo-123`. */
export function instanceImage(instanceId: string): string {
  return `swebench/sweb.eval.x86_64.${instanceId.replace("__", "_1776_").toLowerCase()}:latest`;
}

/** Capability the setup step needs to hand the repo to the sandbox user. The agent never has it. */
export const SETUP_CAPABILITY = "CHOWN";

/**
 * Runs once as root, before the agent starts:
 *  1. `/repo` becomes a link to the repo, so every tool keeps working on `/repo`;
 *  2. the repo is cut back to what `HEAD` can reach: every other branch, tag and remote is removed,
 *     and commits that only they reached are deleted for good. Otherwise `git log --all` could show
 *     the agent the real fix. Images built after the fix was found usually have no such commits,
 *     so the costly `gc` only runs when there are some;
 *  3. the repo is handed to the sandbox user, so the agent (not root) can edit, test and commit.
 */
export function setupScript(dir: string): string {
  const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
  return [
    "set -e",
    `cd ${quoted}`,
    'if [ -e /repo ] && [ ! -L /repo ]; then echo "/repo already exists in the image" >&2; exit 1; fi',
    `ln -sfn ${quoted} /repo`,
    "head=$(git rev-parse HEAD)",
    'future=$(git rev-list --all --not "$head" | head -n 1)',
    'git checkout -q --detach "$head"',
    "git for-each-ref --format='%(refname)' | while read -r ref; do git update-ref -d \"$ref\"; done",
    "git reflog expire --expire=now --all",
    'if [ -n "$future" ]; then git gc -q --prune=now; fi',
    "rm -f .git/ORIG_HEAD .git/FETCH_HEAD",
    `chown -R ${SANDBOX_USER} ${quoted}`,
  ].join("\n");
}
