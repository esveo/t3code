import {
  type InitiativeAcceptanceCheck,
  InitiativesError,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  agentAuthor,
  CHECKED_ENTRY_TYPES,
  checkPromptBlock,
  type InitiativeRole,
  type InitiativeToolName,
  mayUseTool,
  PARTICIPANT_ENTRY_TYPES,
  roleOfThread,
  sessionStateOf,
} from "@t3tools/initiatives/model";
import { BRAIN_FILES } from "@t3tools/initiatives/brain";
import { threadLinkHref } from "@t3tools/shared/threadOrchestration";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadDecisions from "../../threadDecisions/ThreadDecisions.ts";
import type { Escalate } from "../InitiativeChecks.ts";
import { selectEntries } from "../InitiativeEntries.ts";
import { Initiatives, type InitiativesShape, type ThreadMembership } from "../Initiatives.ts";
import { InitiativeToolError, InitiativesToolkit } from "./tools.ts";

const fail = (detail: string) => new InitiativeToolError({ detail });
const fromService = (error: { readonly message: string }) => fail(error.message);

const link = (threadId: string, title: string) =>
  `[${title.replaceAll("]", ")")}](${threadLinkHref(threadId)})`;

/** A check as the tools take it, with the optional fields made explicit. */
const acceptanceCheckOf = (input: {
  readonly kind: InitiativeAcceptanceCheck["kind"];
  readonly description: string;
  readonly ref?: string | undefined;
  readonly expected?: string | undefined;
}): InitiativeAcceptanceCheck => ({
  kind: input.kind,
  description: input.description,
  ref: input.ref?.trim() || null,
  expected: input.expected?.trim() || null,
});

interface Caller {
  readonly threadId: string;
  readonly membership: ThreadMembership | null;
  readonly role: InitiativeRole | null;
}

const make = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Initiatives);
  const decisions = Option.getOrNull(yield* Effect.serviceOption(ThreadDecisions.ThreadDecisions));
  const crypto = yield* Crypto.Crypto;
  const service: InitiativesShape | null = Option.getOrNull(found);

  // Read when the layer is built, and again at the call when it was not there yet.
  const requireService = service
    ? Effect.succeed(service)
    : Effect.flatMap(Effect.serviceOption(Initiatives), (live) =>
        Option.isSome(live)
          ? Effect.succeed(live.value)
          : Effect.fail(fail("This server does not keep initiatives.")),
      );
  const requireDecisions = decisions
    ? Effect.succeed(decisions)
    : Effect.flatMap(Effect.serviceOption(ThreadDecisions.ThreadDecisions), (live) =>
        Option.isSome(live)
          ? Effect.succeed(live.value)
          : Effect.fail(fail("This server does not keep an Inbox.")),
      );

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

  /** An entry of the caller's initiative; entries of others stay out of reach. */
  const requireOwnEntry = (initiatives: InitiativesShape, initiativeId: string, entryId: string) =>
    initiatives.entries.requireEntry(entryId).pipe(
      Effect.mapError(fromService),
      Effect.flatMap((entry) =>
        entry.initiativeId === initiativeId
          ? Effect.succeed(entry)
          : Effect.fail(fail(`No entry ${entryId} in this initiative.`)),
      ),
    );

  /** Raises a task whose corrections ran out as a question in the coordinator's Inbox. */
  const escalateFor =
    (inboxThreadId: string): Escalate =>
    ({ entry, title, question }) =>
      Effect.gen(function* () {
        const inboxes = yield* requireDecisions;
        yield* inboxes.upsert(ThreadId.make(inboxThreadId), {
          // Stable per task, so a repeated escalation updates the one question.
          id: `task-${entry.id}-plan`,
          title,
          question,
          urgency: "today",
          ...(entry.threadId ? { sourceThreadId: entry.threadId } : {}),
        });
      }).pipe(Effect.mapError((error) => new InitiativesError({ message: error.message })));

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
        const task = input.taskId
          ? yield* requireOwnEntry(initiatives, own.id, input.taskId)
          : null;
        if (task && task.type !== "task") return yield* fail(`${task.id} is no task.`);
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
              prompt: task?.acceptanceCheck
                ? `${checkPromptBlock({ entryId: task.id, check: task.acceptanceCheck })}\n\n${input.prompt}`
                : input.prompt,
              provider: input.provider,
              model: input.model,
              worktree: input.worktree,
              baseBranch: input.baseBranch,
              parentThreadId: ThreadId.make(caller.threadId),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        if (task) {
          yield* initiatives.checks
            .assignThread(task.id, job.threadId, authorOf(caller))
            .pipe(Effect.mapError(fromService));
        }
        return {
          threadId: job.threadId,
          link: link(job.threadId, job.spec.title),
          status: job.status,
        };
      }),

    brain_read: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("brain_read");
        const own = yield* targetOf(caller, undefined);
        const page = yield* initiatives.brain
          .read(own.id, input.path ?? BRAIN_FILES.index, 10)
          .pipe(Effect.mapError(fromService));
        const record = yield* initiatives.store
          .findByKey("brainPage", `${own.id}|${page.path}`)
          .pipe(Effect.mapError(fromService));
        return {
          path: page.path,
          markdown: page.markdown,
          lockedBy: Option.isSome(record) ? record.value.lockedBy : null,
          history: page.history.map(({ author, at, message }) => ({ author, at, message })),
        };
      }),

    brain_search: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("brain_search");
        const own = yield* targetOf(caller, undefined);
        const hits = yield* initiatives.brain
          .search(own.id, input.query, Math.min(Math.max(input.limit ?? 30, 1), 100))
          .pipe(Effect.mapError(fromService));
        return { hits };
      }),

    brain_write: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("brain_write");
        const own = caller.membership!.initiative;
        if (input.path.trim() === BRAIN_FILES.handoff) {
          return yield* fail("Write the handoff with handoff_update.");
        }
        const written = yield* initiatives.brain
          .write(own, {
            path: input.path,
            markdown: input.markdown,
            author: authorOf(caller),
            sources: input.sources,
          })
          .pipe(Effect.mapError(fromService));
        return { path: written.path, changed: written.changed };
      }),

    handoff_update: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("handoff_update");
        const written = yield* initiatives.brain
          .writeHandoff(caller.membership!.initiative, input, authorOf(caller))
          .pipe(Effect.mapError(fromService));
        return { changed: written.changed };
      }),

    brain_tidy: () =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("brain_tidy");
        return yield* initiatives.brain
          .tidy(caller.membership!.initiative.id)
          .pipe(Effect.mapError(fromService));
      }),

    question_ask: (input) =>
      Effect.gen(function* () {
        const { caller } = yield* callerFor("question_ask");
        const own = caller.membership!.initiative;
        const inboxes = yield* requireDecisions;
        // The coordinator's Inbox; a thread of an initiative without one asks in its own.
        const inboxThreadId = ThreadId.make(own.coordinatorThreadId ?? caller.threadId);
        const fromOther = inboxThreadId !== caller.threadId;
        const id =
          input.id ??
          (input.title
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) ||
            "frage");
        const decision = yield* inboxes
          .upsert(inboxThreadId, {
            id,
            title: input.title,
            question: input.question,
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.options ? { options: input.options } : {}),
            ...(input.urgency ? { urgency: input.urgency } : {}),
            ...(fromOther
              ? { sourceThreadId: caller.threadId, routeToThreadId: caller.threadId }
              : {}),
          })
          .pipe(Effect.mapError(fromService));
        return { questionId: decision.id, inboxThreadId };
      }),

    entry_create: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("entry_create");
        if (caller.role !== "coordinator" && !PARTICIPANT_ENTRY_TYPES.has(input.type)) {
          return yield* fail(
            `Threads of the initiative record issues and assumptions; a ${input.type} is for the coordinator.`,
          );
        }
        if (input.acceptanceCheck && !CHECKED_ENTRY_TYPES.has(input.type)) {
          return yield* fail("Only a task or plan carries an acceptance check.");
        }
        const entry = yield* initiatives.entries
          .create(
            {
              initiativeId: caller.membership!.initiative.id,
              type: input.type,
              title: input.title,
              bodyMd: input.body,
              details: input.details,
              originThreadId: ThreadId.make(caller.threadId),
              acceptanceCheck: input.acceptanceCheck
                ? acceptanceCheckOf(input.acceptanceCheck)
                : null,
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { entryId: entry.id, status: entry.status };
      }),

    stats_estimate: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("stats_estimate");
        const own = yield* targetOf(caller, undefined);
        return yield* initiatives.stats
          .estimate(own.id, input.provider, input.model ?? null)
          .pipe(Effect.mapError(fromService));
      }),

    entry_list: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("entry_list");
        const own = yield* targetOf(caller, undefined);
        const all = yield* initiatives.store
          .list("entry", { initiativeId: own.id })
          .pipe(Effect.mapError(fromService));
        return {
          entries: selectEntries(all, input)
            .slice(0, 100)
            .map((entry) => ({
              entryId: entry.id,
              type: entry.type,
              title: entry.title,
              status: entry.status,
              body: entry.bodyMd.slice(0, 2000),
              createdBy: entry.createdBy,
              createdAt: entry.createdAt,
              supersedes: entry.supersedes,
              needsReview: entry.details["needsReview"] === true,
              inbox: entry.inbox !== null,
            })),
        };
      }),

    decision_record: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("decision_record");
        const own = caller.membership!.initiative;
        const author = authorOf(caller);
        const { dependsOn, title, rationale, ...details } = input;
        const entry = yield* initiatives.entries
          .create(
            {
              initiativeId: own.id,
              type: "decision",
              title,
              bodyMd: rationale ?? "",
              details: { ...details, decidedBy: author },
              originThreadId: ThreadId.make(caller.threadId),
            },
            author,
          )
          .pipe(Effect.mapError(fromService));
        for (const assumptionId of dependsOn ?? []) {
          yield* requireOwnEntry(initiatives, own.id, assumptionId);
          yield* initiatives.entries
            .link(entry.id, assumptionId, "dependsOn", author)
            .pipe(Effect.mapError(fromService));
        }
        return { entryId: entry.id, status: entry.status };
      }),

    decision_reopen: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("decision_reopen");
        const entry = yield* requireOwnEntry(
          initiatives,
          caller.membership!.initiative.id,
          input.entryId,
        );
        if (entry.type !== "decision") return yield* fail("Only a decision is reopened.");
        const updated = yield* initiatives.entries
          .setStatus(entry.id, "reopened", authorOf(caller), input.reason)
          .pipe(Effect.mapError(fromService));
        return { status: updated.status };
      }),

    entry_supersede: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("entry_supersede");
        yield* requireOwnEntry(initiatives, caller.membership!.initiative.id, input.entryId);
        const next = yield* initiatives.entries
          .supersede(
            input.entryId,
            {
              title: input.title,
              bodyMd: input.body,
              details: input.details,
              originThreadId: ThreadId.make(caller.threadId),
            },
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { entryId: next.id };
      }),

    entry_link: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("entry_link");
        const own = caller.membership!.initiative.id;
        yield* requireOwnEntry(initiatives, own, input.fromId);
        yield* requireOwnEntry(initiatives, own, input.toId);
        yield* initiatives.entries
          .link(input.fromId, input.toId, input.kind, authorOf(caller))
          .pipe(Effect.mapError(fromService));
        return { linked: true };
      }),

    entry_status: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("entry_status");
        yield* requireOwnEntry(initiatives, caller.membership!.initiative.id, input.entryId);
        const updated = yield* initiatives.entries
          .setStatus(input.entryId, input.status, authorOf(caller), input.note)
          .pipe(Effect.mapError(fromService));
        return { status: updated.status };
      }),

    check_define: ({ entryId, ...check }) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("check_define");
        yield* requireOwnEntry(initiatives, caller.membership!.initiative.id, entryId);
        const entry = yield* initiatives.checks
          .setCheck(entryId, acceptanceCheckOf(check), authorOf(caller))
          .pipe(Effect.mapError(fromService));
        return { entryId: entry.id };
      }),

    check_report: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("check_report");
        const own = caller.membership!.initiative;
        yield* requireOwnEntry(initiatives, own.id, input.entryId);
        const author = authorOf(caller);
        const entry = yield* initiatives.checks
          .report(input.entryId, input, author)
          .pipe(Effect.mapError(fromService));
        // A failure seen by another thread goes back to the one doing the task;
        // the worker reporting its own failure simply keeps fixing it.
        const sendBack =
          input.outcome === "failed" &&
          entry.type === "task" &&
          entry.threadId != null &&
          entry.threadId !== caller.threadId;
        if (!sendBack) {
          return {
            outcome: input.outcome,
            returned: false,
            escalated: false,
            attempts: entry.attempts ?? 0,
          };
        }
        const outcome = yield* initiatives.checks
          .returnUnit(
            entry.id,
            {
              finding:
                `The acceptance check failed: ${input.excerpt ?? input.url ?? input.commit ?? ""}`.trim(),
              scope: "Make the acceptance check pass; change nothing else.",
            },
            author,
            escalateFor(own.coordinatorThreadId ?? caller.threadId),
          )
          .pipe(Effect.mapError(fromService));
        return {
          outcome: input.outcome,
          returned: outcome.status === "returned",
          escalated: outcome.status === "escalated",
          attempts: outcome.attempts,
        };
      }),

    task_return: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("task_return");
        const own = caller.membership!.initiative;
        yield* requireOwnEntry(initiatives, own.id, input.entryId);
        const outcome = yield* initiatives.checks
          .returnUnit(
            input.entryId,
            {
              finding: input.finding,
              scope: input.scope,
              threadId: input.threadId ? ThreadId.make(input.threadId) : undefined,
            },
            authorOf(caller),
            escalateFor(own.coordinatorThreadId ?? caller.threadId),
          )
          .pipe(Effect.mapError(fromService));
        return { status: outcome.status, attempts: outcome.attempts };
      }),

    rollback_mark: (input) =>
      Effect.gen(function* () {
        const { initiatives, caller } = yield* callerFor("rollback_mark");
        const own = caller.membership!.initiative.id;
        if ((input.entryId === undefined) === (input.observationId === undefined)) {
          return yield* fail("Name either the task (entryId) or the request (observationId).");
        }
        if (input.entryId !== undefined) {
          yield* requireOwnEntry(initiatives, own, input.entryId);
        } else {
          const observation = yield* initiatives.store
            .get("observation", input.observationId!)
            .pipe(Effect.mapError(fromService));
          if (Option.isNone(observation) || observation.value.initiativeId !== own) {
            return yield* fail(`No request ${input.observationId} in this initiative.`);
          }
        }
        yield* initiatives.checks
          .markRolledBack(
            input.entryId !== undefined ? "entry" : "observation",
            (input.entryId ?? input.observationId)!,
            input.rolledBack,
            authorOf(caller),
          )
          .pipe(Effect.mapError(fromService));
        return { rolledBack: input.rolledBack };
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
