import { assert, describe, it } from "@effect/vitest";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
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
  }) => Effect.Effect<A, E>,
  crossProjectThreads = true,
) => {
  const layer = DelegatedWorkspace.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(PROJECTS),
          getById: () => Effect.succeedNone,
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
      ),
    ),
  );
  return Effect.gen(function* () {
    const workspace = yield* DelegatedWorkspace.DelegatedWorkspace;
    return yield* body({ workspace });
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
          },
          workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: false },
        });
      }),
    ),
  );

  it.effect("starts a worktree in the coordinator's project from the coordinator's branch", () =>
    withWorkspace(({ workspace }) =>
      Effect.gen(function* () {
        const plan = yield* workspace.plan(parent, { worktree: true });
        assert.deepEqual(plan.workspaceStrategy, {
          type: "worktree",
          baseRef: "feature/coordinator",
          startFromOrigin: false,
        });
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
});
