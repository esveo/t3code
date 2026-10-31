import { assert, describe, it } from "@effect/vitest";

import {
  completeVoiceDelegation,
  frontEndInstructions,
  parseVoiceDelegation,
} from "./voiceCallPrompt.ts";

describe("completeVoiceDelegation", () => {
  it("restores what the voice cut off mid-sentence", () => {
    assert.equal(
      completeVoiceDelegation(
        "? Lass mal schauen. Also alles",
        ". Ähm. Und dann welche Bilder? Lass mal schauen. Also alles",
      ),
      "Ähm. Und dann welche Bilder? Lass mal schauen. Also alles",
    );
  });

  it("keeps words the transcript has not delivered yet", () => {
    assert.equal(completeVoiceDelegation("mach das bitte", "Ja, mach das"), "Ja, mach das bitte");
  });

  it("keeps a delegation in the voice's own words", () => {
    assert.equal(completeVoiceDelegation("Run the tests", "Kannst du testen?"), "Run the tests");
  });
});

describe("parseVoiceDelegation", () => {
  it("queues on the marker and strips it", () => {
    assert.deepEqual(parseVoiceDelegation("[queue] Run the tests", "steer"), {
      mode: "queue",
      text: "Run the tests",
    });
  });

  it("queues on the user's words when the voice forgot the marker", () => {
    assert.equal(parseVoiceDelegation("Schieb das in die Queue", "steer").mode, "queue");
    assert.equal(parseVoiceDelegation("Stell das hinten an", "steer").mode, "queue");
  });

  it("follows the setting when nothing is said about it", () => {
    assert.equal(parseVoiceDelegation("Fix die Ecken", "steer").mode, "auto");
    assert.equal(parseVoiceDelegation("Fix die Ecken", "queue").mode, "queue");
  });

  it("steers against a queue setting only when asked", () => {
    assert.deepEqual(parseVoiceDelegation("[now] Stopp", "queue"), { mode: "auto", text: "Stopp" });
    assert.equal(parseVoiceDelegation("Mach das sofort", "queue").mode, "auto");
  });
});

describe("frontEndInstructions", () => {
  const instructions = (threadContext: ReadonlyArray<{ role: string; text: string }>) =>
    frontEndInstructions({
      language: "de",
      persona: "",
      targetTitle: "Thread",
      nowIso: "2026-10-30T00:00:00Z",
      followUpBehavior: "steer",
      threadContext,
    });

  it("carries only the latest thread messages, shortened", () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: "user",
      text: `message ${index}`,
    }));
    const text = instructions([...messages, { role: "assistant", text: "x".repeat(700) }]);
    assert.notInclude(text, "message 2");
    assert.include(text, "message 3");
    assert.include(text, `Agent: ${"x".repeat(600)}…`);
  });

  it("leaves the block out for a new thread", () => {
    assert.notInclude(instructions([]), "latest messages");
  });
});
