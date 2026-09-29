/**
 * Fork: the loops of an initiative's tasks. A task or plan carries an
 * acceptance check fixed before the work; threads report its result with
 * evidence; a task counts as done only after a passed check or a person's
 * explicit acceptance without one (see taskDoneBlocker). A failed unit goes
 * back alone to the thread that made it, with the finding and the scope of the
 * correction; after MAX_RETURN_ATTEMPTS corrections an agent's return is not
 * sent but raised as a question in the Inbox, since the fault then likely
 * lies in the plan. Rollbacks of finished work are marked here too.
 */
import {
  type InitiativeAcceptanceCheck,
  type InitiativeAuthor,
  type InitiativeCheckResult,
  type InitiativeEntry,
  type InitiativeEntryReturn,
  InitiativesError,
  type ThreadId,
} from "@t3tools/contracts";
import type { ThreadBridge } from "@t3tools/initiatives/bridge";
import {
  escalationQuestion,
  isCheckedEntry,
  MAX_RETURN_ATTEMPTS,
  returnMessage,
} from "@t3tools/initiatives/model";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const failure = (message: string) => new InitiativesError({ message });

const isPerson = (author: InitiativeAuthor) => author.startsWith("person:");

/** Raises the question of a task whose corrections ran out, in the coordinator's Inbox. */
export type Escalate = (input: {
  readonly entry: InitiativeEntry;
  readonly title: string;
  readonly question: string;
}) => Effect.Effect<void, InitiativesError>;

export interface CheckReport {
  readonly outcome: InitiativeCheckResult["outcome"];
  readonly excerpt?: string | null | undefined;
  readonly url?: string | null | undefined;
  readonly commit?: string | null | undefined;
}

export type ReturnOutcome =
  | { readonly status: "returned"; readonly attempts: number; readonly threadId: ThreadId }
  | { readonly status: "escalated"; readonly attempts: number };

export const makeInitiativeChecks = (options: {
  readonly store: InitiativeStore;
  readonly bridge: Pick<ThreadBridge, "sendMessage">;
  readonly changed: (initiativeId: string | null) => Effect.Effect<unknown>;
}) => {
  const { store, changed } = options;
  const fromStore = (error: { readonly message: string }) => failure(error.message);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const requireChecked = (entryId: string) =>
    store.get("entry", entryId).pipe(
      Effect.mapError(fromStore),
      Effect.flatMap((found) => {
        if (Option.isNone(found)) return Effect.fail(failure(`No entry ${entryId}.`));
        return isCheckedEntry(found.value)
          ? Effect.succeed(found.value)
          : Effect.fail(failure("Only a task or plan of the initiative carries a check."));
      }),
    );

  const save = (
    entry: InitiativeEntry,
    patch: Partial<Omit<InitiativeEntry, "id" | "revision">>,
    author: InitiativeAuthor,
  ) =>
    store.update("entry", entry.id, patch, { author }).pipe(
      Effect.mapError(fromStore),
      Effect.tap((updated) => changed(updated.initiativeId)),
    );

  const setCheck = (
    entryId: string,
    check: InitiativeAcceptanceCheck | null,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const entry = yield* requireChecked(entryId);
      if (check?.kind === "command" && !check.ref?.trim()) {
        return yield* failure("A command check names the command to run in ref.");
      }
      return yield* save(entry, { acceptanceCheck: check }, author);
    });

  /**
   * Records a check's result. A result without evidence is refused: a pass
   * is what the check showed, never the absence of an error.
   */
  const report = (entryId: string, input: CheckReport, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const entry = yield* requireChecked(entryId);
      const check = entry.acceptanceCheck;
      if (!check) {
        return yield* failure(
          "This entry has no acceptance check yet; the coordinator defines one with check_define.",
        );
      }
      const evidence = {
        excerpt: input.excerpt?.trim() || null,
        url: input.url?.trim() || null,
        commit: input.commit?.trim() || null,
      };
      if (!evidence.excerpt && !evidence.url && !evidence.commit) {
        return yield* failure(
          "Report the evidence: the output excerpt, a link or the commit the check looked at.",
        );
      }
      if (input.outcome === "passed" && check.kind === "command" && !evidence.excerpt) {
        return yield* failure(
          "A passed command check needs the output excerpt that shows the expected result.",
        );
      }
      if (input.outcome === "passed" && check.kind === "mergedPr" && !evidence.url) {
        return yield* failure("A passed pull-request check needs the link to the merged PR.");
      }
      const result: InitiativeCheckResult = {
        outcome: input.outcome,
        evidence,
        reportedBy: author,
        reportedAt: yield* nowIso,
      };
      return yield* save(entry, { checkResults: [...(entry.checkResults ?? []), result] }, author);
    });

  const acceptWithoutCheck = (entryId: string, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      if (!isPerson(author)) {
        return yield* failure("Only the user accepts a task without a passed check.");
      }
      const entry = yield* requireChecked(entryId);
      return yield* save(entry, { acceptedWithoutCheckBy: author, status: "done" }, author);
    });

  /**
   * Hands a task back to its thread with the finding and the scope. Every
   * return counts an attempt. An agent's return after the last correction is
   * not sent: it escalates to the Inbox instead. A person's return always goes.
   */
  const returnUnit = (
    entryId: string,
    input: {
      readonly finding: string;
      readonly scope: string;
      /** For a task that names no thread yet. */
      readonly threadId?: ThreadId | undefined;
    },
    author: InitiativeAuthor,
    escalate?: Escalate,
  ) =>
    Effect.gen(function* () {
      const entry = yield* requireChecked(entryId);
      if (entry.type !== "task") return yield* failure("Only a task goes back to its thread.");
      const threadId = entry.threadId ?? input.threadId ?? null;
      const attempts = entry.attempts ?? 0;
      const at = yield* nowIso;
      if (!isPerson(author) && attempts >= MAX_RETURN_ATTEMPTS) {
        if (!escalate) return yield* failure("The corrections ran out; ask the user.");
        const question = escalationQuestion({
          title: entry.title,
          attempts,
          finding: input.finding,
        });
        yield* escalate({ entry, ...question });
        const escalation: InitiativeEntryReturn = {
          finding: input.finding,
          scope: input.scope,
          toThreadId: null,
          by: author,
          at,
          escalated: true,
        };
        yield* save(entry, { returns: [...(entry.returns ?? []), escalation] }, author);
        return { status: "escalated", attempts } satisfies ReturnOutcome;
      }
      if (!threadId) {
        return yield* failure(
          "The task names no thread to return it to; pass the thread that did it.",
        );
      }
      const next = attempts + 1;
      yield* options.bridge
        .sendMessage(
          threadId,
          returnMessage({
            entryId: entry.id,
            title: entry.title,
            attempt: next,
            finding: input.finding,
            scope: input.scope,
            check: entry.acceptanceCheck,
          }),
        )
        .pipe(Effect.mapError((error) => failure(error.message)));
      const returned: InitiativeEntryReturn = {
        finding: input.finding,
        scope: input.scope,
        toThreadId: threadId,
        by: author,
        at,
        escalated: false,
      };
      yield* save(
        entry,
        {
          attempts: next,
          returns: [...(entry.returns ?? []), returned],
          threadId,
          status: "running",
        },
        author,
      );
      return { status: "returned", attempts: next, threadId } satisfies ReturnOutcome;
    });

  /** The thread a task was started in; the task runs from then on. */
  const assignThread = (entryId: string, threadId: ThreadId, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const entry = yield* requireChecked(entryId);
      return yield* save(
        entry,
        { threadId, ...(entry.status === "open" ? { status: "running" } : {}) },
        author,
      );
    });

  const markRolledBack = (
    target: "entry" | "observation",
    id: string,
    rolledBack: boolean,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      if (target === "entry") {
        const entry = yield* requireChecked(id);
        if (entry.type !== "task") return yield* failure("Only a task's work is rolled back.");
        yield* save(entry, { rolledBackBy: rolledBack ? author : null }, author);
        return entry.initiativeId;
      }
      const found = yield* store.get("observation", id).pipe(Effect.mapError(fromStore));
      if (Option.isNone(found)) return yield* failure(`No observation ${id}.`);
      yield* store
        .update("observation", id, { rolledBackBy: rolledBack ? author : null }, { author })
        .pipe(Effect.mapError(fromStore));
      yield* changed(found.value.initiativeId);
      return found.value.initiativeId;
    });

  return { setCheck, report, acceptWithoutCheck, returnUnit, assignThread, markRolledBack };
};

export type InitiativeChecks = ReturnType<typeof makeInitiativeChecks>;
