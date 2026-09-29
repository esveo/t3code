import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DelegatedWorkspace from "./DelegatedWorkspace.ts";

const project = (id: string, title: string, workspaceRoot: string) =>
  ({ id: ProjectId.make(id), title, workspaceRoot }) as OrchestrationProjectShell;

const PROJECTS = [
  project("project-web", "Web", "/repo/web"),
  project("project-api", "Api", "/repo/api"),
  project("project-notes", "Notes", "/plain/notes"),
];

const parent = {
  projectId: ProjectId.make("project-web"),
  branch: "feature/coordinator",
  worktreePath: "/repo/web-worktrees/coordinator",
};

const withWorkspace = <A, E>(
  body: (test: {
    readonly workspace: DelegatedWorkspace.DelegatedWorkspace["Service"];
    readonly prepared: Array<{
      readonly input: ThreadLaunch.ThreadLaunchInput;
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }>;
  }) => Effect.Effect<A, E>,
  crossProjectThreads = true,
) => {
  const prepared: Array<{
    readonly input: ThreadLaunch.ThreadLaunchInput;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }> = [];
  const layer = DelegatedWorkspace.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(PROJECTS),
          getById: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: ({ cwd }) =>
            Effect.succeed({
              isRepo: !cwd.startsWith("/plain"),
              refName: cwd === "/repo/api" ? "main" : "feature/coordinator",
            } as never),
          hasCommit: ({ refName }) =>
            Effect.succeed(["main", "feature/coordinator", "origin/release"].includes(refName)),
          listRefs: () =>
            Effect.succeed({
              refs: [
                { name: "release" },
                { name: "origin/release", isRemote: true, remoteName: "origin" },
              ],
              nextCursor: null,
            } as never),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          prepareWorkspace: (input, threadId, runId) =>
            Effect.sync(() => void prepared.push({ input, threadId, runId })),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const workspace = yield* DelegatedWorkspace.DelegatedWorkspace;
    return yield* body({ workspace, prepared });
  }).pipe(
    Effect.provide(
      Layer.merge(
        layer,
        ServerSettings.layerTest({ enableCrossProjectThreads: crossProjectThreads }),
      ),
    ),
  );
};

describe("DelegatedWorkspace", () => {
  it.effect("gives a child in another project its own worktree off that project's HEAD", () =>
    withWorkspace(({ workspace }) =>
      Effect.gen(function* () {
        const plan = yield* workspace.plan(parent, { project: "api", worktree: true });
        assert.deepEqual(plan, {
          command: {
            projectId: ProjectId.make("project-api"),
            branch: null,
            worktreePath: null,
            prepare: true,
          },
          worktree: { baseRef: "main" },
        });
      }),
    ),
  );

  it.effect("starts a worktree in the coordinator's project from the coordinator's branch", () =>
    withWorkspace(({ workspace }) =>
      Effect.gen(function* () {
        const plan = yield* workspace.plan(parent, { worktree: true });
        assert.deepEqual(plan.worktree, { baseRef: "feature/coordinator" });
        assert.equal(plan.command.projectId, "project-web");
      }),
    ),
  );

  it.effect(
    "shares the coordinator's checkout, or another project's root, without a worktree",
    () =>
      withWorkspace(({ workspace }) =>
        Effect.gen(function* () {
          assert.deepEqual((yield* workspace.plan(parent, {})).command, {
            projectId: parent.projectId,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
          });
          assert.deepEqual((yield* workspace.plan(parent, { project: "project-api" })).command, {
            projectId: ProjectId.make("project-api"),
            branch: null,
            worktreePath: null,
          });
        }),
      ),
  );

  it.effect("names the branches meant by a base ref that does not resolve", () =>
    withWorkspace(({ workspace }) =>
      Effect.gen(function* () {
        const error = yield* workspace
          .plan(parent, { project: "Api", worktree: true, baseRef: "relase" })
          .pipe(Effect.flip);
        assert.include(error.message, "relase is not a commit in Api");
        assert.include(error.message, "Did you mean: release, origin/release?");
      }),
    ),
  );

  it.effect("refuses a worktree outside git and an unknown project", () =>
    withWorkspace(({ workspace }) =>
      Effect.gen(function* () {
        const plain = yield* workspace
          .plan(parent, { project: "Notes", worktree: true })
          .pipe(Effect.flip);
        assert.include(plain.message, "Notes is not a git repository");
        const unknown = yield* workspace.plan(parent, { project: "Mobile" }).pipe(Effect.flip);
        assert.include(unknown.message, "No project matches Mobile");
      }),
    ),
  );

  it.effect("keeps the child in this thread's project while cross-project threads are off", () =>
    withWorkspace(
      ({ workspace }) =>
        Effect.gen(function* () {
          const refused = yield* workspace.plan(parent, { project: "Api" }).pipe(Effect.flip);
          assert.include(refused.message, "Cross-project threads");
          const own = yield* workspace.plan(parent, { worktree: true });
          assert.equal(own.command.projectId, parent.projectId);
        }),
      false,
    ),
  );

  it.effect("provisions the planned worktree for the child's waiting run", () =>
    withWorkspace(({ workspace, prepared }) =>
      Effect.gen(function* () {
        const plan = yield* workspace.plan(parent, { project: "Api", worktree: true });
        yield* workspace.prepare({
          commandId: CommandId.make("command:delegate"),
          plan,
          childThreadId: ThreadId.make("child"),
          childRunId: RunId.make("child-run"),
          title: "Port the importer",
          task: "Port the importer.",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        assert.equal(prepared.length, 1);
        assert.deepEqual(prepared[0]!.input.workspaceStrategy, {
          type: "worktree",
          baseRef: "main",
        });
        assert.equal(prepared[0]!.input.projectId, "project-api");
        assert.equal(prepared[0]!.threadId, "child");
        assert.equal(prepared[0]!.runId, "child-run");
      }),
    ),
  );
});
