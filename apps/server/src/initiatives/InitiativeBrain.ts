/**
 * Fork: the initiatives' side of the brain. It writes through the one
 * BrainArchive writer, keeps each page's record (layer, title, lock, last
 * commit) in the store, and remembers the last failure per initiative so the
 * page shows it until a write succeeds again.
 */
import {
  type Initiative,
  type InitiativeAuthor,
  type InitiativeBrainPageContent,
  InitiativesError,
} from "@t3tools/contracts";
import {
  agentWriteBlocker,
  BRAIN_FILES,
  type Handoff,
  initialBrainPages,
  layerOfPath,
  normalizeBrainPath,
  renderHandoff,
  titleOfPage,
} from "@t3tools/initiatives/brain";
import type { InitiativeStore } from "@t3tools/initiatives/store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { BrainArchiveShape, BrainSearchHit } from "./BrainArchive.ts";

const failure = (message: string) => new InitiativesError({ message });

const EMPTY_HANDOFF = renderHandoff({ openTasks: [], lastResults: [], nextStep: "" }).trim();

export interface BrainTidyReport {
  readonly notInIndex: ReadonlyArray<string>;
  readonly missingFromBrain: ReadonlyArray<string>;
  readonly outdated: ReadonlyArray<string>;
  readonly locked: ReadonlyArray<string>;
}

export const makeInitiativeBrain = (options: {
  readonly store: InitiativeStore;
  readonly archive: BrainArchiveShape;
  readonly changed: (initiativeId: string) => Effect.Effect<unknown>;
}) => {
  const { store, archive, changed } = options;
  const errors = new Map<string, string>();

  const pathOf = (raw: string) => {
    const normalized = normalizeBrainPath(raw);
    return "error" in normalized
      ? Effect.fail(failure(normalized.error))
      : Effect.succeed(normalized.path);
  };

  /** Records a failure for the page to show, then fails with it. */
  const failed = (initiativeId: string) => (error: { readonly message: string }) =>
    Effect.gen(function* () {
      errors.set(initiativeId, error.message);
      yield* changed(initiativeId);
      return yield* failure(error.message);
    });

  const pageKey = (initiativeId: string, path: string) => `${initiativeId}|${path}`;

  const recordPage = (input: {
    readonly initiativeId: string;
    readonly path: string;
    readonly markdown: string;
    readonly commit: string | null;
    readonly author: InitiativeAuthor;
    readonly sources?: ReadonlyArray<string> | undefined;
    /** Only an edit locks; the pages a brain starts with and recovered ones do not. */
    readonly lock?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const existing = yield* store.findByKey("brainPage", pageKey(input.initiativeId, input.path));
      const fields = {
        layer: layerOfPath(input.path),
        title: titleOfPage(input.path, input.markdown),
        lastCommit: input.commit,
        ...(input.sources ? { sources: input.sources } : {}),
        // A person's edit locks the page against agents; the person can unlock it.
        ...(input.lock && input.author.startsWith("person:") ? { lockedBy: input.author } : {}),
      };
      if (Option.isSome(existing)) {
        return yield* store.update("brainPage", existing.value.id, fields, {
          author: input.author,
        });
      }
      return yield* store.insert(
        "brainPage",
        {
          initiativeId: input.initiativeId,
          path: input.path,
          status: "current",
          sources: [],
          lockedBy: null,
          ...fields,
        },
        input.author,
      );
    }).pipe(Effect.mapError((error) => failure(error.message)));

  /** Brings the page records in line with what git holds, after a restart or a crash. */
  const syncPages = (initiativeId: string, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const pages = yield* archive.pages(initiativeId);
      for (const page of pages) {
        const record = yield* store
          .findByKey("brainPage", pageKey(initiativeId, page.path))
          .pipe(Effect.mapError((error) => failure(error.message)));
        if (Option.isSome(record) && record.value.lastCommit === page.commit) continue;
        const markdown = (yield* archive.read(initiativeId, page.path)) ?? "";
        yield* recordPage({ initiativeId, path: page.path, markdown, commit: page.commit, author });
      }
    }).pipe(Effect.catchTag("BrainError", failed(initiativeId)));

  /** Creates the brain of an initiative that has none, with its first pages. */
  const ensure = (
    initiative: Pick<Initiative, "id" | "title" | "goalText">,
    author: InitiativeAuthor,
  ) =>
    Effect.gen(function* () {
      const { created } = yield* archive.ensure(
        initiative.id,
        initialBrainPages(initiative),
        author,
      );
      if (created) yield* syncPages(initiative.id, author);
    }).pipe(Effect.catchTag("BrainError", failed(initiative.id)));

  const write = (
    initiative: Pick<Initiative, "id" | "title" | "goalText">,
    input: {
      readonly path: string;
      readonly markdown: string;
      readonly author: InitiativeAuthor;
      readonly sources?: ReadonlyArray<string> | undefined;
      readonly message?: string | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const path = yield* pathOf(input.path);
      yield* ensure(initiative, input.author);
      const record = yield* store
        .findByKey("brainPage", pageKey(initiative.id, path))
        .pipe(Effect.mapError((error) => failure(error.message)));
      const blocker = agentWriteBlocker(Option.getOrNull(record), input.author);
      if (blocker) return yield* failure(blocker);
      const result = yield* archive
        .write(initiative.id, {
          path,
          markdown: input.markdown,
          author: input.author,
          message: input.message ?? `Update ${path}`,
        })
        .pipe(Effect.catchTag("BrainError", failed(initiative.id)));
      yield* recordPage({
        initiativeId: initiative.id,
        path,
        markdown: input.markdown,
        commit: result.commit,
        author: input.author,
        sources: input.sources,
        lock: true,
      });
      errors.delete(initiative.id);
      yield* changed(initiative.id);
      return { path, commit: result.commit, changed: result.changed };
    });

  const read = (initiativeId: string, rawPath: string, historyLimit = 20) =>
    Effect.gen(function* () {
      const path = yield* pathOf(rawPath);
      const markdown = yield* archive.read(initiativeId, path);
      const history =
        markdown === null ? [] : yield* archive.history(initiativeId, path, historyLimit);
      return { path, markdown, history } satisfies InitiativeBrainPageContent;
    }).pipe(Effect.catchTag("BrainError", (error) => Effect.fail(failure(error.message))));

  const search = (initiativeId: string, query: string, limit = 30) =>
    archive
      .search(initiativeId, query, limit)
      .pipe(
        Effect.catchTag(
          "BrainError",
          (error): Effect.Effect<ReadonlyArray<BrainSearchHit>, InitiativesError> =>
            Effect.fail(failure(error.message)),
        ),
      );

  const writeHandoff = (
    initiative: Pick<Initiative, "id" | "title" | "goalText">,
    handoff: Handoff,
    author: InitiativeAuthor,
  ) =>
    write(initiative, {
      path: BRAIN_FILES.handoff,
      markdown: renderHandoff(handoff),
      author,
      message: "Update the handoff",
    });

  const unlock = (initiativeId: string, rawPath: string, author: InitiativeAuthor) =>
    Effect.gen(function* () {
      const path = yield* pathOf(rawPath);
      const record = yield* store
        .findByKey("brainPage", pageKey(initiativeId, path))
        .pipe(Effect.mapError((error) => failure(error.message)));
      if (Option.isNone(record)) return yield* failure(`No brain page ${path}.`);
      yield* store
        .update("brainPage", record.value.id, { lockedBy: null }, { author })
        .pipe(Effect.mapError((error) => failure(error.message)));
      yield* changed(initiativeId);
    });

  /** What to tidy: pages the index does not name, index links to nothing, outdated pages. */
  const tidy = (initiativeId: string) =>
    Effect.gen(function* () {
      const records = yield* store
        .list("brainPage", { initiativeId })
        .pipe(Effect.mapError((error) => failure(error.message)));
      const index =
        (yield* archive
          .read(initiativeId, BRAIN_FILES.index)
          .pipe(Effect.catchTag("BrainError", () => Effect.succeed(null)))) ?? "";
      const linked = new Set(
        [...index.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((match) => match[1]!.replace(/^\.\//, "")),
      );
      const details = records.filter((record) => record.layer === "detail");
      return {
        notInIndex: details
          .filter((record) => !linked.has(record.path))
          .map((record) => record.path),
        missingFromBrain: [...linked].filter(
          (path) => !records.some((record) => record.path === path),
        ),
        outdated: records
          .filter((record) => record.status !== "current")
          .map((record) => record.path),
        locked: records.filter((record) => record.lockedBy !== null).map((record) => record.path),
      } satisfies BrainTidyReport;
    });

  /** The steckbrief and handoff a start prompt carries, read fresh from the brain. */
  const startBrain = (initiative: Pick<Initiative, "id" | "title" | "goalText">) =>
    Effect.gen(function* () {
      yield* ensure(initiative, "system:brain").pipe(Effect.ignore);
      const readOrNull = (path: string) =>
        archive.read(initiative.id, path).pipe(Effect.orElseSucceed(() => null));
      const handoff = yield* readOrNull(BRAIN_FILES.handoff);
      return {
        steckbrief: yield* readOrNull(BRAIN_FILES.steckbrief),
        // The empty handoff a brain starts with says nothing a coordinator could continue.
        handoff: handoff?.trim() === EMPTY_HANDOFF ? null : handoff,
      };
    });

  /** After a restart: commit what a crash left and bring the records in line. */
  const recover = (initiativeId: string) =>
    Effect.gen(function* () {
      yield* archive.recover(initiativeId);
      yield* syncPages(initiativeId, "system:recover");
    }).pipe(Effect.catchTag("BrainError", failed(initiativeId)));

  return {
    ensure,
    write,
    read,
    search,
    writeHandoff,
    unlock,
    tidy,
    startBrain,
    recover,
    errorOf: (initiativeId: string) => errors.get(initiativeId) ?? null,
  };
};

export type InitiativeBrain = ReturnType<typeof makeInitiativeBrain>;
