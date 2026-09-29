/**
 * Fork: delegate_task into another project and/or a worktree of its own.
 *
 * V2 runs a delegated child in its parent's checkout. A coordinator hands out
 * independent work instead: in another repository, or on a branch of its own
 * so children never step on each other's changes. `plan` turns the tool's
 * `workspace` input into the `delegated_task.request` workspace (the child
 * thread's project, branch and worktree); when the child gets a new worktree,
 * its first run waits in "preparing" and `prepare` provisions the worktree
 * the way a launched thread's is (ThreadLaunchService.prepareWorkspace):
 * checkout, setup script, then the run starts.
 *
 * OrchestratorMcpService reads this service optionally, so its own tests and
 * layers stay as upstream builds them.
 */
import {
  type CommandId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { suggestBranches } from "../mcp/toolkits/threads/branchSuggestions.ts";
import { matchProject } from "../mcp/toolkits/threads/projectMatch.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";

export type DelegatedWorkspaceInput = NonNullable<OrchestratorMcpDelegateTaskInput["workspace"]>;
export type DelegatedWorkspaceCommand = NonNullable<
  Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>["workspace"]
>;

export interface DelegatedWorkspacePlan {
  readonly command: DelegatedWorkspaceCommand;
  /** Set when the child gets a new worktree, which `prepare` then provisions. */
  readonly worktree: { readonly baseRef: string } | null;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export class DelegatedWorkspace extends Context.Service<
  DelegatedWorkspace,
  {
    readonly plan: (
      parent: Pick<OrchestrationV2AppThread, "projectId" | "branch" | "worktreePath">,
      input: DelegatedWorkspaceInput,
    ) => Effect.Effect<DelegatedWorkspacePlan, OrchestratorMcpFailure>;
    /** Provisions the planned worktree in the background and releases the child's run. */
    readonly prepare: (input: {
      readonly commandId: CommandId;
      readonly plan: DelegatedWorkspacePlan;
      readonly childThreadId: ThreadId;
      readonly childRunId: RunId;
      readonly title: string;
      readonly task: string;
      readonly modelSelection: ModelSelection;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    }) => Effect.Effect<void>;
  }
>()("t3/threadOrchestration/DelegatedWorkspace") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;

  /** A base ref that does not resolve, with the branches the caller probably meant. */
  const suggestionsFor = (cwd: string, baseRef: string) =>
    Effect.gen(function* () {
      const refs: Array<VcsListRefsResult["refs"][number]> = [];
      let cursor: number | null = 0;
      while (cursor !== null && refs.length < 5_000) {
        const page: VcsListRefsResult = yield* git.listRefs({
          cwd,
          refKind: "all",
          includeMatchingRemoteRefs: true,
          cursor,
          limit: 200,
        });
        refs.push(...page.refs);
        cursor = page.nextCursor;
      }
      return suggestBranches(baseRef, refs);
    }).pipe(Effect.orElseSucceed((): string[] => []));

  const plan: DelegatedWorkspace["Service"]["plan"] = (parent, input) =>
    Effect.gen(function* () {
      const shells = yield* projects
        .listShells()
        .pipe(Effect.mapError(() => invalid("The projects could not be read.")));
      const matched = input.project
        ? matchProject(shells, input.project)
        : (() => {
            const project = shells.find((candidate) => candidate.id === parent.projectId);
            return project ? { project } : { error: "This thread's project was not found." };
          })();
      if ("error" in matched) return yield* invalid(matched.error);
      const project = matched.project;
      const sameProject = project.id === parent.projectId;
      if (input.worktree !== true) {
        return {
          command: {
            projectId: project.id,
            branch: sameProject ? parent.branch : null,
            worktreePath: sameProject ? parent.worktreePath : null,
          },
          worktree: null,
        };
      }
      // In its own project the worktree starts from this thread's checkout;
      // in another one there is no such checkout, so from that project's.
      const checkout = sameProject
        ? (parent.worktreePath ?? project.workspaceRoot)
        : project.workspaceRoot;
      const status = yield* git
        .localStatus({ cwd: checkout })
        .pipe(Effect.orElseSucceed(() => null));
      if (status === null || !status.isRepo) {
        return yield* invalid(
          `${project.title} is not a git repository, so the child cannot get its own worktree. Leave worktree out to let it work in the project's checkout.`,
        );
      }
      const baseRef =
        input.baseRef ?? (sameProject ? parent.branch : null) ?? status.refName ?? "HEAD";
      const exists = yield* git
        .hasCommit({ cwd: project.workspaceRoot, refName: baseRef })
        .pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        const suggestions = yield* suggestionsFor(project.workspaceRoot, baseRef);
        return yield* invalid(
          `${baseRef} is not a commit in ${project.title}.${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
        );
      }
      return {
        command: { projectId: project.id, branch: null, worktreePath: null, prepare: true },
        worktree: { baseRef },
      };
    });

  const prepare: DelegatedWorkspace["Service"]["prepare"] = (input) =>
    input.plan.worktree === null || launches.prepareWorkspace === undefined
      ? Effect.void
      : launches.prepareWorkspace(
          {
            commandId: input.commandId,
            projectId: input.plan.command.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            workspaceStrategy: { type: "worktree", baseRef: input.plan.worktree.baseRef },
            initialMessage: { text: input.task, attachments: [] },
            createdBy: "agent",
            creationSource: "mcp",
          },
          input.childThreadId,
          input.childRunId,
        );

  return DelegatedWorkspace.of({ plan, prepare });
});

export const layer = Layer.effect(DelegatedWorkspace, make);
