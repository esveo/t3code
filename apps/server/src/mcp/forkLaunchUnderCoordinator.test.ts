import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadCoordinators } from "../threadOrchestration/ThreadCoordinators.ts";
import { launchUnderCoordinator } from "./forkLaunchUnderCoordinator.ts";

const caller = { id: ThreadId.make("coord"), projectId: ProjectId.make("project") };
const threadId = ThreadId.make("launched");

const withLog = (log: string[]) =>
  Layer.mock(ThreadCoordinators)({
    claim: (link) => Effect.sync(() => void log.push(`claim ${link.threadId}`)),
    unclaim: (id) => Effect.sync(() => void log.push(`unclaim ${id}`)),
  });

it.effect("claims the thread before the launch and takes it back when the launch fails", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    const input = { coordinate: true, threadId, projectId: caller.projectId, caller };
    yield* launchUnderCoordinator(
      input,
      Effect.sync(() => void log.push("launch")),
    ).pipe(Effect.provide(withLog(log)));
    assert.deepEqual(log, ["claim launched", "launch"]);

    log.length = 0;
    yield* launchUnderCoordinator(input, Effect.fail("boom")).pipe(
      Effect.flip,
      Effect.provide(withLog(log)),
    );
    assert.deepEqual(log, ["claim launched", "unclaim launched"]);
  }),
);

it.effect("launches as usual without coordinate", () =>
  Effect.gen(function* () {
    const log: string[] = [];
    yield* launchUnderCoordinator(
      { coordinate: undefined, threadId, projectId: caller.projectId, caller },
      Effect.sync(() => void log.push("launch")),
    ).pipe(Effect.provide(withLog(log)));
    assert.deepEqual(log, ["launch"]);
  }),
);
