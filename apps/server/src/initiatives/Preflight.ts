/**
 * Fork: the preflight in shadow mode. It hears every approval request of an
 * initiative's threads from the provider stream (`request.opened`, the only
 * place the action's arguments are), records what the fixed rules would
 * have answered, and then how the request ended: the user's click (a
 * `thread.approval.respond`), the provider's own resolution, or expiry. It
 * answers nothing; the user's click is the measure.
 */
import {
  type InitiativeApprovalObservation,
  type InitiativeAuthor,
  InitiativesError,
  type PreflightReport,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  actionFingerprint,
  classifyRequest,
  collectEvidence,
  PREFLIGHT_RULE_VERSION,
  preflightStats,
  readAction,
  rollbackReport,
} from "@t3tools/initiatives/preflight";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { InitiativesShape } from "./Initiatives.ts";

const failure = (message: string) => new InitiativesError({ message });

/** Requests that are no approvals: questions to the user and token refreshes. */
const NOT_APPROVALS: ReadonlySet<string> = new Set(["tool_user_input", "auth_tokens_refresh"]);

/** How many of a thread's latest requests the approval card can look up. */
const THREAD_OBSERVATION_LIMIT = 50;

export interface RequestOpened {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly requestType: string;
  readonly detail?: string | undefined;
  readonly args?: unknown;
  readonly warnings: ReadonlyArray<string>;
}

export const makePreflight = (options: {
  readonly initiatives: Pick<InitiativesShape, "store" | "membershipOf" | "threads">;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
  readonly digest: (text: string) => Effect.Effect<string>;
}) => {
  const { store } = options.initiatives;
  const fromStore = (error: { readonly message: string }) => failure(error.message);
  const author = "system:preflight" as const;
  const key = (threadId: string, requestId: string) => `${threadId}|${requestId}`;

  const workspaceRootOf = (projectId: string, worktreePath: string | null) =>
    worktreePath
      ? Effect.succeed(worktreePath)
      : options.initiatives.threads.listProjects().pipe(
          Effect.map(
            (projects) =>
              projects.find((project) => project.projectId === projectId)?.workspaceRoot ?? null,
          ),
          Effect.orElseSucceed(() => null),
        );

  /**
   * The evidence behind a verdict, in its fixed order: the thread's task
   * checks, its earlier requests in this run, and its rollbacks.
   */
  const evidenceFor = (initiativeId: string, threadId: string, actionHash: string) =>
    Effect.gen(function* () {
      const [entries, earlier] = yield* Effect.all([
        store.list("entry", { initiativeId }),
        store.list("observation", { groupKey: threadId }),
      ]).pipe(Effect.mapError(fromStore));
      return collectEvidence({
        tasks: entries.filter((entry) => entry.type === "task" && entry.threadId === threadId),
        earlier,
        actionHash,
      });
    }).pipe(Effect.orElseSucceed(() => []));

  /** Records the request and the rules' verdict, for a thread of an initiative in shadow mode. */
  const observeOpened = (request: RequestOpened) =>
    Effect.gen(function* () {
      if (NOT_APPROVALS.has(request.requestType)) return null;
      const membership = yield* options.initiatives
        .membershipOf(request.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(membership)) return null;
      const initiative = membership.value.initiative;
      if (initiative.preflightMode === "off") return null;
      const existing = yield* store
        .findByKey("observation", key(request.threadId, request.requestId))
        .pipe(Effect.mapError(fromStore));
      if (Option.isSome(existing)) return existing.value;
      const shell = Option.getOrNull(
        yield* options.initiatives.threads
          .findThread(request.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none())),
      );
      const started = yield* Clock.currentTimeMillis;
      const action = readAction({ detail: request.detail, args: request.args });
      const workspaceRoot = shell
        ? yield* workspaceRootOf(shell.projectId, shell.worktreePath)
        : null;
      const verdict = classifyRequest({
        requestType: request.requestType,
        action,
        workspaceRoot,
        warnings: request.warnings,
      });
      const actionHash = yield* options.digest(actionFingerprint(request.requestType, action));
      const evidence = yield* evidenceFor(initiative.id, request.threadId, actionHash);
      const latencyMs = (yield* Clock.currentTimeMillis) - started;
      const observation = yield* store
        .insert(
          "observation",
          {
            initiativeId: initiative.id,
            threadId: request.threadId,
            requestId: request.requestId,
            provider: request.provider,
            runtimeMode: shell?.runtimeMode ?? "unknown",
            requestType: request.requestType,
            action,
            actionHash,
            providerWarning: request.warnings[0] ?? null,
            openedAt: request.createdAt,
            resolvedBy: null,
            decision: null,
            resolvedAt: null,
            verdicts: [
              {
                checker: "rules",
                ruleVersion: PREFLIGHT_RULE_VERSION,
                ...verdict,
                latencyMs,
                evidence,
              },
            ],
            markedWrongBy: null,
          },
          author,
        )
        .pipe(
          // The stream can repeat an event; the first record stays.
          Effect.catchTag("InitiativeStoreError", (error) =>
            error.reason === "duplicate" ? Effect.succeed(null) : Effect.fail(error),
          ),
          Effect.mapError(fromStore),
        );
      if (observation) yield* options.changed(initiative.id);
      return observation;
    });

  /**
   * How a request ended. The user's click wins over the provider's own
   * resolution, which follows it; a resolution without a click came from the
   * provider (or expired).
   */
  const observeResolution = (input: {
    readonly threadId: string;
    readonly requestId: string;
    readonly by: "person" | "provider-auto" | "expired";
    readonly decision: string | null;
    readonly at: string;
  }) =>
    Effect.gen(function* () {
      const found = yield* store
        .findByKey("observation", key(input.threadId, input.requestId))
        .pipe(Effect.mapError(fromStore));
      if (Option.isNone(found)) return;
      const observation = found.value;
      if (observation.resolvedBy === "person" && input.by !== "person") return;
      if (observation.resolvedBy === input.by && observation.decision === input.decision) return;
      yield* store
        .update(
          "observation",
          observation.id,
          { resolvedBy: input.by, decision: input.decision, resolvedAt: input.at },
          { author },
        )
        .pipe(Effect.mapError(fromStore));
      yield* options.changed(observation.initiativeId);
    });

  const markWrong = (observationId: string, wrong: boolean, by: InitiativeAuthor) =>
    Effect.gen(function* () {
      const found = yield* store.get("observation", observationId).pipe(Effect.mapError(fromStore));
      if (Option.isNone(found)) return yield* failure(`No observation ${observationId}.`);
      yield* store
        .update("observation", observationId, { markedWrongBy: wrong ? by : null }, { author: by })
        .pipe(Effect.mapError(fromStore));
      yield* options.changed(found.value.initiativeId);
    });

  const report = (initiativeId: string | null) =>
    Effect.gen(function* () {
      const filter = initiativeId === null ? {} : { initiativeId };
      const [observations, entries] = yield* Effect.all([
        store.list("observation", filter),
        store.list("entry", filter),
      ]).pipe(Effect.mapError(fromStore));
      const shells = yield* options.initiatives.threads
        .listThreads()
        .pipe(Effect.orElseSucceed(() => []));
      const providers = new Map<string, string>();
      const titles = new Map(shells.map((shell) => [shell.id as string, shell.title]));
      for (const shell of shells) {
        const instanceId = shell.modelSelection?.instanceId;
        if (instanceId) providers.set(shell.id, instanceId);
      }
      const rollbacks = rollbackReport({
        observations,
        tasks: entries.filter((entry) => entry.inbox === null),
        providerOf: (threadId) => providers.get(threadId) ?? null,
        titleOf: (threadId) => titles.get(threadId) ?? null,
      });
      return {
        providers: preflightStats(observations, rollbacks.byProvider),
        threads: rollbacks.threads,
        observations: observations
          .toSorted((a, b) => b.openedAt.localeCompare(a.openedAt))
          .slice(0, 200),
      } satisfies PreflightReport;
    });

  const threadObservations = (threadId: string) =>
    store.list("observation", { groupKey: threadId }).pipe(
      Effect.mapError(fromStore),
      Effect.map((observations): ReadonlyArray<InitiativeApprovalObservation> =>
        observations.slice(-THREAD_OBSERVATION_LIMIT),
      ),
    );

  return { observeOpened, observeResolution, markWrong, report, threadObservations };
};

export type Preflight = ReturnType<typeof makePreflight>;

/** The request.opened fields the preflight reads. */
export function requestOpenedOf(event: ProviderRuntimeEvent): RequestOpened | null {
  if (event.type !== "request.opened" || !event.requestId) return null;
  return {
    threadId: event.threadId,
    requestId: event.requestId,
    provider: event.providerInstanceId ?? event.provider,
    createdAt: event.createdAt,
    requestType: event.payload.requestType,
    detail: event.payload.detail,
    args: event.payload.args,
    warnings: (event.payload.options ?? []).flatMap((option) =>
      option.warning ? [option.warning] : [],
    ),
  };
}

/** SHA-256 of a text, hex, through the server's crypto. */
export const makeDigest = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return (text: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(
      Effect.map((bytes) =>
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.orElseSucceed(() => text.slice(0, 64)),
    );
});
