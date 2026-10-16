import { describe, expect, it } from "vitest";
import { readOnlyBashTool, readOnlyViolation } from "../src/tools/readonly-bash.js";
import { newRunState } from "../src/context/state.js";
import { fakeSandbox } from "./helpers/fake-sandbox.js";

describe("readOnlyViolation: allowed", () => {
  it.each([
    "ls -la src",
    "cat src/a.ts | head -20",
    "grep -rn 'foo|bar' src",
    'grep -E "a;b" src | wc -l',
    "find . -name '*.ts' -not -path './node_modules/*'",
    "git log --oneline -5",
    "git diff HEAD~1 -- src",
    'rg -n "TODO" .',
  ])("%s", (cmd) => {
    expect(readOnlyViolation(cmd)).toBeNull();
  });
});

describe("readOnlyViolation: refused", () => {
  it.each([
    ["echo x > a", "redirect"],
    ["cat a >> b", "append"],
    ["ls; rm -rf .", "semicolon"],
    ["ls && rm a", "and"],
    ["ls || rm a", "or"],
    ["ls $(rm a)", "substitution"],
    ["ls `rm a`", "backtick"],
    ['grep "$(rm a)" .', "substitution in double quotes"],
    ["grep 'unbalanced .", "unbalanced quote"],
    ["rm a", "not allowed"],
    ["sed -i s/a/b/ f", "sed"],
    ["find . -exec rm {} +", "find exec"],
    ["find . -delete", "find delete"],
    ["rg --pre ./x foo", "rg pre"],
    ["git commit -m x", "git commit"],
    ["git checkout .", "git checkout"],
    ["git diff --output=a", "git output"],
    ["cat a | tee b", "tee"],
    ["ls |", "empty segment"],
    ["ls\nrm a", "newline"],
  ])("%s (%s)", (cmd) => {
    expect(readOnlyViolation(cmd)).not.toBeNull();
  });
});

describe("readOnlyBashTool", () => {
  it("runs an allowed command", async () => {
    const f = fakeSandbox();
    const res = await readOnlyBashTool.run({ cmd: "ls" }, { sandbox: f.sandbox, step: 1 });
    expect(res.isError).toBe(false);
    expect(f.exec).toHaveBeenCalledWith("ls", {});
  });

  it("refuses without touching the sandbox", async () => {
    const f = fakeSandbox();
    const res = await readOnlyBashTool.run(
      { cmd: "rm -rf /" },
      { sandbox: f.sandbox, step: 1, run: newRunState() },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("Command refused");
    expect(f.exec).not.toHaveBeenCalled();
  });
});
