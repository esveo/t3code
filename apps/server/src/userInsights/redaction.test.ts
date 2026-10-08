import { describe, expect, it } from "@effect/vitest";

import { isMostlyPasted, redact } from "./redaction.ts";

describe("redact", () => {
  it.each([
    ["PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["ANTHROPIC_KEY", "sk-ant-api03-abcdefghijklmnop"],
    ["API_KEY", "sk-proj-abcdefghijklmnopqrstu"],
    ["GITHUB_TOKEN", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["GITHUB_TOKEN", "github_pat_11ABCDEFG0123456789abcdef"],
    ["AWS_KEY", "AKIAIOSFODNN7EXAMPLE"],
    ["SLACK_TOKEN", "xoxb-1234567890-abcdefghij"],
    ["GOOGLE_KEY", "AIzaSyA-abcdefghijklmnopqrstuvwxyz0123"],
    ["EMAIL", "paul.behla@example.com"],
    ["HEX", "0123456789abcdef0123456789abcdef01"],
    ["BLOB", "QWxhZGRpbjpvcGVuIHNlc2FtZQ9abcXYZ12345"],
  ])("replaces %s", (kind, secret) => {
    const result = redact(`before ${secret} after`);
    expect(result).toBe(`before [REDACTED:${kind}] after`);
  });

  it("keeps the name of an assigned secret and hides its value", () => {
    expect(redact("set API_TOKEN=hunter2 and password: swordfish")).toBe(
      "set API_TOKEN=[REDACTED:SECRET] and password: [REDACTED:SECRET]",
    );
  });

  it("leaves paths, identifiers and normal prose alone", () => {
    const text =
      "Fix apps/server/src/userInsights/HaikuCliRunnerImplementation2.ts and useComposerDraftStoreSelectorHandler, then run the tests.";
    expect(redact(text)).toBe(text);
  });
});

describe("isMostlyPasted", () => {
  it("is false for a typed message", () => {
    expect(isMostlyPasted("Kannst du bitte die Tests laufen lassen?")).toBe(false);
  });

  it("is true when most of the message is a code fence", () => {
    expect(isMostlyPasted(`look:\n\`\`\`\n${"const x = 1;\n".repeat(20)}\`\`\``)).toBe(true);
  });

  it("is true for very long messages", () => {
    expect(isMostlyPasted("word ".repeat(1000))).toBe(true);
  });
});
