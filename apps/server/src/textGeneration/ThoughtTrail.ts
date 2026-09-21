import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  ThoughtTrailError,
  type ThoughtTrailInput,
  type ThoughtTrailResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as TextGeneration from "./TextGeneration.ts";

/**
 * Recap one turn's thinking on the project's text-generation model.
 *
 * The trace never leaves the server: the client asks by turn, the turn's
 * reasoning is read from the projection here, and only the trail goes back.
 * That keeps a megabyte of thinking off the wire for a result the reader
 * measures in sentences.
 */
export const summarizeTurnThoughts = Effect.fnUntraced(function* (input: {
  readonly request: ThoughtTrailInput;
  readonly projection: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
}) {
  const thread = yield* input.projection
    .getThreadDetailById(input.request.threadId, { activityKinds: [] })
    .pipe(
      Effect.mapError(
        (cause) => new ThoughtTrailError({ detail: "Failed to read the thread.", cause }),
      ),
      Effect.map(Option.getOrUndefined),
    );
  if (thread === undefined) {
    return yield* Effect.fail(new ThoughtTrailError({ detail: "Thread not found." }));
  }

  const trace = thread.messages
    .filter((message) => message.role === "reasoning" && message.turnId === input.request.turnId)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (trace.length === 0) {
    return yield* Effect.fail(new ThoughtTrailError({ detail: "This turn did not think." }));
  }

  const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
    yield* input.settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new ThoughtTrailError({ detail: "Failed to read settings.", cause }),
      ),
    ),
    thread.projectId,
  ).settings;

  // Only somewhere to run: the prompt carries the whole input, and the
  // adapters that read a checkout use a temp directory for this operation.
  const project = yield* input.projection.getProjectShellById(thread.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  const cwd = thread.worktreePath ?? project?.workspaceRoot ?? process.cwd();

  const generated = yield* input.textGeneration
    .summarizeThoughts({ cwd, trace, modelSelection })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ThoughtTrailError({ detail: `Could not recap the thinking: ${cause.detail}`, cause }),
      ),
    );

  return {
    steps: generated.steps,
    outcome: generated.outcome,
    model: modelSelection.model,
  } satisfies ThoughtTrailResult;
});
