import { parseTaggedThreadMessage, wrapFromCoordinator } from "@t3tools/shared/threadOrchestration";
import { describe, expect, it } from "@effect/vitest";

import { childTaskText } from "./childTask.ts";

describe("childTaskText", () => {
  it("leaves the prompt alone without a language", () => {
    expect(childTaskText({ prompt: "  Fix the bug.  " })).toBe("Fix the bug.");
  });

  it("asks the thread to answer in the user's language, inside the coordinator's message", () => {
    const text = wrapFromCoordinator({
      coordinatorThreadId: "coordinator",
      coordinatorTitle: "Audit",
      text: childTaskText({ prompt: "Fix the bug.", language: " German\n" }),
    });
    expect(parseTaggedThreadMessage(text)?.body).toBe(
      "Fix the bug.\n\nWrite your answers to the user in German, unless the user asks otherwise. Keep code, commit messages and identifiers in the language the project uses.",
    );
  });
});
