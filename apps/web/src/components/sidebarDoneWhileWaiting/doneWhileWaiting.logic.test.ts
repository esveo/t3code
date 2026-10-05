import { describe, expect, it } from "vite-plus/test";

import { resolveDoneWhileWaitingStatus } from "./doneWhileWaiting.logic";

type Thread = Parameters<typeof resolveDoneWhileWaitingStatus>[1];

function thread(
  kinds: ReadonlyArray<Thread["pendingBackgroundTasks"][number]["kind"]>,
  runStatus = "completed",
): Thread {
  return {
    latestRun: { status: runStatus } as Thread["latestRun"],
    pendingBackgroundTasks: kinds.map((kind, index) => ({
      taskId: `task-${index}`,
      kind,
    })) as Thread["pendingBackgroundTasks"],
  };
}

describe("resolveDoneWhileWaitingStatus", () => {
  it("shows an unseen completion that only left a command running as done", () => {
    expect(resolveDoneWhileWaitingStatus("waiting", thread(["command"]), true)).toBe("ready");
  });

  it("goes back to waiting once the completion has been seen", () => {
    expect(resolveDoneWhileWaitingStatus("waiting", thread(["command"]), false)).toBe("waiting");
  });

  it("keeps waiting while a subagent or monitor will wake the agent", () => {
    expect(resolveDoneWhileWaitingStatus("waiting", thread(["command", "subagent"]), true)).toBe(
      "waiting",
    );
    expect(resolveDoneWhileWaitingStatus("waiting", thread(["monitor"]), true)).toBe("waiting");
  });

  it("keeps waiting when the run did not complete", () => {
    expect(resolveDoneWhileWaitingStatus("waiting", thread(["command"], "interrupted"), true)).toBe(
      "waiting",
    );
  });

  it("leaves every other status alone", () => {
    expect(resolveDoneWhileWaitingStatus("working", thread(["command"]), true)).toBe("working");
  });
});
