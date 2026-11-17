import { describe, expect, it } from "vitest";
import { describeFinding, scanDiff } from "../src/agent/secrets.js";

const diff = (...added: string[]): string =>
  [
    "diff --git a/src/x.js b/src/x.js",
    "--- a/src/x.js",
    "+++ b/src/x.js",
    "@@ -1 +1 @@",
    ...added,
  ].join("\n");

describe("scanDiff", () => {
  it("finds the usual key shapes on added lines, named by kind, file and line", () => {
    const d = diff(
      `+const aws = "AKIA${"A".repeat(16)}";`,
      `+const ant = "sk-ant-${"a".repeat(30)}";`,
      `+const oai = "sk-proj-${"b".repeat(30)}";`,
      `+const gh = "ghp_${"c".repeat(36)}";`,
      `+const slack = "xoxb-${"1".repeat(12)}";`,
      `+const google = "AIza${"d".repeat(35)}";`,
      "+-----BEGIN RSA PRIVATE KEY-----",
      `+password = "${"p".repeat(16)}"`,
    );
    expect(scanDiff(d).map((f) => [f.kind, f.file, f.line])).toEqual([
      ["AWS access key id", "src/x.js", 5],
      ["Anthropic API key", "src/x.js", 6],
      ["OpenAI API key", "src/x.js", 7],
      ["GitHub token", "src/x.js", 8],
      ["Slack token", "src/x.js", 9],
      ["Google API key", "src/x.js", 10],
      ["private key", "src/x.js", 11],
      ["a credential-looking value", "src/x.js", 12],
    ]);
  });

  it("reads only the lines the patch adds", () => {
    const d = diff(
      `-const gone = "AKIA${"A".repeat(16)}";`,
      ` const kept = "AKIA${"B".repeat(16)}";`,
    );
    expect(scanDiff(d)).toEqual([]);
    expect(scanDiff(`+++ b/AKIA${"C".repeat(16)}`)).toEqual([]);
  });

  it("lets plain stand-ins through", () => {
    const d = diff(
      '+apiKey: "your-api-key-here"',
      '+token = "<paste the token here>"',
      '+secret: "${SECRET_FROM_ENV}"',
      '+password = "xxxxxxxxxxxxxxxx"',
      '+password = "short"',
    );
    expect(scanDiff(d)).toEqual([]);
  });

  it("never repeats the matched text", () => {
    const key = `AKIA${"Z".repeat(16)}`;
    const found = scanDiff(diff(`+x = "${key}"`));
    expect(JSON.stringify(found)).not.toContain(key);
    expect(found.map(describeFinding)).toEqual(["AWS access key id in src/x.js, diff line 5"]);
  });

  it("copes with a diff that has no file header", () => {
    expect(scanDiff(`+key = "AKIA${"Q".repeat(16)}"`)).toEqual([
      { kind: "AWS access key id", line: 1 },
    ]);
  });
});
