import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import {
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ServerSettings from "../serverSettings.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import { summarizeTurnThoughts } from "./ThoughtTrail.ts";

const THREAD_ID = ThreadId.make("11111111-1111-4111-8111-111111111111");
const PROJECT_ID = ProjectId.make("22222222-2222-4222-8222-222222222222");
const TURN_ID = TurnId.make("33333333-3333-4333-8333-333333333333");
const OTHER_TURN_ID = TurnId.make("44444444-4444-4444-8444-444444444444");

const message = (role: string, text: string, turnId: TurnId | null) => ({
  id: `${role}-${text}`,
  role,
  text,
  turnId,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeProjection = (messages: ReadonlyArray<ReturnType<typeof message>>) =>
  ({
    getThreadDetailById: () =>
      Effect.succeed(
        Option.some({ id: THREAD_ID, projectId: PROJECT_ID, worktreePath: "/tmp/tree", messages }),
      ),
    getProjectShellById: () => Effect.succeed(Option.none()),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna");

const settings = {
  getSettings: Effect.succeed({
    textGenerationModelSelection: modelSelection,
    projectSettingsOverrides: {},
  }),
} as unknown as ServerSettings.ServerSettingsService["Service"];

const makeTextGeneration = (
  summarizeThoughts: TextGeneration.TextGeneration["Service"]["summarizeThoughts"],
) => ({ summarizeThoughts }) as unknown as TextGeneration.TextGeneration["Service"];

describe("summarizeTurnThoughts", () => {
  it.effect("sends only that turn's reasoning, in order", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const selections: Array<{ options?: ReadonlyArray<unknown> }> = [];
      const result = yield* summarizeTurnThoughts({
        request: { threadId: THREAD_ID, turnId: TURN_ID },
        projection: makeProjection([
          message("user", "fix it", null),
          message("reasoning", "Read the resolver.", TURN_ID),
          message("assistant", "Fixed.", TURN_ID),
          message("reasoning", "Ran the test.", TURN_ID),
          message("reasoning", "A later turn.", OTHER_TURN_ID),
        ]),
        settings,
        textGeneration: makeTextGeneration((input) => {
          seen.push(input.trace);
          selections.push(input.modelSelection);
          return Effect.succeed({ steps: ["Read the resolver"], outcome: "Fixed it" });
        }),
      });

      expect(seen).toEqual(["Read the resolver.\n\nRan the test."]);
      // A recap never needs the model to deliberate first.
      expect(selections.at(0)?.options).toEqual([
        { id: "thinking", value: false },
        { id: "effort", value: "low" },
        { id: "reasoningEffort", value: "low" },
      ]);
      expect(result).toEqual({
        steps: ["Read the resolver"],
        outcome: "Fixed it",
        model: modelSelection.model,
      });
    }),
  );

  it.effect("refuses a turn that did not think", () =>
    summarizeTurnThoughts({
      request: { threadId: THREAD_ID, turnId: TURN_ID },
      projection: makeProjection([message("assistant", "Fixed.", TURN_ID)]),
      settings,
      textGeneration: makeTextGeneration(() => Effect.die("must not be called")),
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.detail).toContain("did not think");
      }),
    ),
  );

  it.effect("reports a failed generation instead of an empty trail", () =>
    summarizeTurnThoughts({
      request: { threadId: THREAD_ID, turnId: TURN_ID },
      projection: makeProjection([message("reasoning", "Thinking.", TURN_ID)]),
      settings,
      textGeneration: makeTextGeneration(() =>
        Effect.fail(
          new TextGenerationError({ operation: "summarizeThoughts", detail: "codex exited 1" }),
        ),
      ),
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.detail).toContain("codex exited 1");
      }),
    ),
  );
});
