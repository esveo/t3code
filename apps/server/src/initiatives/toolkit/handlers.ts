import { type OrchestrationThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  agentAuthor,
  type InitiativeRole,
  type InitiativeToolName,
  mayUseTool,
  roleOfThread,
  sessionStateOf,
} from "@t3tools/initiatives/model";
import { threadLinkHref } from "@t3tools/shared/threadOrchestration";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { Initiatives, type InitiativesShape, type ThreadMembership } from "../Initiatives.ts";
import { InitiativeToolError, InitiativesToolkit } from "./tools.ts";

const fail = (detail: string) => new InitiativeToolError({ detail });
const fromService = (error: { readonly message: string }) => fail(error.message);

const link = (threadId: string, title: string) =>
  `[${title.replaceAll("]", ")")}](${threadLinkHref(threadId)})`;

interface Caller {
  readonly threadId: string;
  readonly membership: ThreadMembership | null;
  readonly role: InitiativeRole | null;
}

const make = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Initiatives);
  const crypto = yield* Crypto.Crypto;
  const service: InitiativesShape | null = Option.getOrNull(found);

  const requireService = service
    ? Effect.succeed(service)
    : Effect.fail(fail("This server does not keep initiatives."));

  /** The calling thread, its initiative and its role there, checked against the tool's profile. */
  const callerFor = (tool: InitiativeToolName) =>
    Effect.gen(function* () {
      const initiatives = yield* requireService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const membership = Option.getOrNull(
        yield* initiatives.membershipOf(scope.threadId).pipe(Effect.mapError(fromService)),
      );
      const role = membership ? roleOfThread(membership.initiative, scope.threadId) : null;
      if (!mayUseTool(tool, role)) {
        return yield* fail(
          role === null
            ? "This thread does not belong to an initiative. The user assigns it on the Initiatives page."
            : `${tool} is for the initiative's coordinator; this thread is a participant.`,
        );
      }
      return {
        initiatives,
        caller: { threadId: scope.threadId, membership, role } satisfies Caller,
      };
    });

  /** The initiative a reading tool looks at: the caller's own, never another one. */
  const targetOf = (caller: Caller, initiativeId: string | undefined) => {
    const own = caller.membership?.initiative;
    if (!own) return Effect.fail(fail("This thread does not belong to an initiative."));
    if (initiativeId !== undefined && initiativeId !== own.id) {
      return Effect.fail(fail("A thread can only read its own initiative."));
    }
    return Effect.succeed(own);
  };

  const authorOf = (caller: Caller) => agentAuthor(caller.role ?? "agent", caller.threadId);

  const liveShells = (initiatives: InitiativesShape) =>
    initiatives.threads.listThreads().pipe(
      Effect.map(
        (threads) =>
          new Map<string, OrchestrationThreadShell>(threads.map((thread) => [thread.id, thread])),
      ),
      Effect.orElseSucceed(() => new Map<string, OrchestrationThreadShell>()),
    );

  return InitiativesToolkit.of({
    initiative_list: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_list");
        const list = yield* initiatives.listSnapshot.pipe(Effect.mapError(fromService));
        return {
          initiatives: list.initiatives
            .filter(
              (entry) => input.includeArchived === true || entry.initiative.status !== "archived",
            )
            .map((entry) => ({
              initiativeId: entry.initiative.id,
              title: entry.initiative.title,
              goal: entry.initiative.goalText,
              status: entry.initiative.status,
              sessions: entry.sessionCount,
              yours: caller.membership?.initiative.id === entry.initiative.id,
            })),
        };
      }),

    initiative_brief: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_brief");
        const own = yield* targetOf(caller, input.initiativeId);
        const detail = yield* initiatives.detailSnapshot(own.id).pipe(Effect.mapError(fromService));
        const initiative = detail.initiative ?? own;
        return {
          initiativeId: initiative.id,
          title: initiative.title,
          goal: initiative.goalText,
          status: initiative.status,
          instructions: initiative.instructionsMd,
          role: caller.role!,
          projects: detail.projects.map((project) => ({
            projectId: project.projectId,
            label: project.label,
            workspaceRoot: project.workspaceRoot,
          })),
          providerExclusions: initiative.providerExclusions,
          halted: initiative.halted,
        };
      }),

    initiative_status: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_status");
        const own = yield* targetOf(caller, input.initiativeId);
        const detail = yield* initiatives.detailSnapshot(own.id).pipe(Effect.mapError(fromService));
        const shells = yield* liveShells(initiatives);
        const now = yield* Clock.currentTimeMillis;
        const counts: Record<string, number> = {};
        for (const session of detail.sessions) {
          if (session.assignment === "released") continue;
          const state = sessionStateOf(session.threadId ? shells.get(session.threadId) : null, now);
          counts[state] = (counts[state] ?? 0) + 1;
        }
        return {
          title: own.title,
          counts,
          failedStarts: detail.launchJobs
            .filter((job) => job.status === "failed")
            .map((job) => ({ title: job.spec.title, error: job.error ?? "" })),
        };
      }),

    session_list: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("session_list");
        const own = yield* targetOf(caller, input.initiativeId);
        const detail = yield* initiatives.detailSnapshot(own.id).pipe(Effect.mapError(fromService));
        const shells = yield* liveShells(initiatives);
        const now = yield* Clock.currentTimeMillis;
        return {
          sessions: detail.sessions
            .filter(
              (session) => input.includeReleased === true || session.assignment !== "released",
            )
            .map((session) => {
              const shell = session.threadId ? shells.get(session.threadId) : undefined;
              const title = shell?.title ?? session.title;
              return {
                threadId: session.threadId,
                title,
                link: session.threadId ? link(session.threadId, title) : null,
                state: sessionStateOf(shell, now),
                assignment: session.assignment,
                branch: shell?.branch ?? session.branch,
                pullRequests: shell?.pullRequests.map((pullRequest) => pullRequest.url) ?? [],
              };
            }),
        };
      }),

    initiative_create: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_create");
        const result = yield* initiatives
          .act(
            {
              type: "create",
              title: input.title,
              ...(input.goal !== undefined ? { goalText: input.goal } : {}),
              ...(input.instructions !== undefined ? { instructionsMd: input.instructions } : {}),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { initiativeId: result.id! };
      }),

    initiative_update: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_update");
        const own = caller.membership!.initiative;
        // An agent may tighten the exclusions, never loosen them.
        const exclusions = input.excludeProviders
          ? [...new Set([...own.providerExclusions, ...input.excludeProviders])]
          : undefined;
        yield* initiatives
          .act(
            {
              type: "update",
              initiativeId: own.id,
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.goal !== undefined ? { goalText: input.goal } : {}),
              ...(input.instructions !== undefined ? { instructionsMd: input.instructions } : {}),
              ...(exclusions ? { providerExclusions: exclusions } : {}),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        const updated = yield* initiatives.store
          .get("initiative", own.id)
          .pipe(Effect.mapError(fromService));
        return { revision: Option.isSome(updated) ? updated.value.revision : own.revision };
      }),

    initiative_archive: () =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_archive");
        yield* initiatives
          .act(
            { type: "archive", initiativeId: caller.membership!.initiative.id },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { status: "archived" };
      }),

    initiative_reopen: () =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_reopen");
        yield* initiatives
          .act({ type: "reopen", initiativeId: caller.membership!.initiative.id }, authorOf(caller))
          .pipe(Effect.mapError(fromService));
        return { status: "active" };
      }),

    initiative_start_thread: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("initiative_start_thread");
        const own = caller.membership!.initiative;
        const detail = yield* initiatives.detailSnapshot(own.id).pipe(Effect.mapError(fromService));
        const projects = detail.projects.filter((project) => project.projectId !== null);
        const wanted = input.project?.toLowerCase();
        const project = wanted
          ? projects.find(
              (candidate) =>
                candidate.projectId === input.project || candidate.label.toLowerCase() === wanted,
            )
          : projects[0];
        if (!project?.projectId) {
          return yield* fail(
            projects.length === 0
              ? "The initiative has no project yet; the user adds one on the Initiatives page."
              : `No project ${input.project} in the initiative. Projects: ${projects.map((candidate) => candidate.label).join(", ")}.`,
          );
        }
        const key = input.key
          ? `${own.id}:${input.key}`
          : `${own.id}:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
        const job = yield* initiatives
          .launch(
            {
              initiativeId: own.id,
              key,
              projectId: ProjectId.make(project.projectId),
              title: input.title,
              prompt: input.prompt,
              provider: input.provider,
              model: input.model,
              worktree: input.worktree,
              baseBranch: input.baseBranch,
              parentThreadId: ThreadId.make(caller.threadId),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return {
          threadId: job.threadId,
          link: link(job.threadId, job.spec.title),
          status: job.status,
        };
      }),

    session_assign: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("session_assign");
        yield* initiatives
          .act(
            {
              type: "assignThread",
              initiativeId: caller.membership!.initiative.id,
              threadId: ThreadId.make(input.threadId),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { assigned: true };
      }),

    session_unassign: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("session_unassign");
        if (input.threadId === caller.threadId) {
          return yield* fail("The coordinator cannot take itself out of its initiative.");
        }
        yield* initiatives
          .act(
            {
              type: "unassignThread",
              initiativeId: caller.membership!.initiative.id,
              threadId: ThreadId.make(input.threadId),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { unassigned: true };
      }),
  });
});

export const InitiativesToolkitHandlersLive = InitiativesToolkit.toLayer(make);
