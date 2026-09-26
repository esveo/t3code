/**
 * Fork: the brain of each initiative as a git repository of its own, at
 * `<state dir>/initiatives/<initiative id>/brain`. One writer serializes every
 * write, so parallel threads never race on the index; a write reports success
 * only once git committed it. No remote is configured and nothing is pushed.
 */
import type { InitiativeAuthor, InitiativeBrainCommit } from "@t3tools/contracts";
import { gitIdentityOf } from "@t3tools/initiatives/brain";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

export class BrainError extends Schema.TaggedError<BrainError>()("BrainError", {
  message: Schema.String,
}) {}

export interface BrainSearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface BrainArchiveShape {
  /** Creates the repository with these pages when it does not exist yet. */
  readonly ensure: (
    initiativeId: string,
    pages: ReadonlyArray<{ readonly path: string; readonly markdown: string }>,
    author: InitiativeAuthor,
  ) => Effect.Effect<{ readonly created: boolean }, BrainError>;
  readonly exists: (initiativeId: string) => Effect.Effect<boolean>;
  readonly read: (initiativeId: string, path: string) => Effect.Effect<string | null, BrainError>;
  readonly write: (
    initiativeId: string,
    input: {
      readonly path: string;
      readonly markdown: string;
      readonly author: InitiativeAuthor;
      readonly message: string;
    },
  ) => Effect.Effect<{ readonly commit: string; readonly changed: boolean }, BrainError>;
  readonly search: (
    initiativeId: string,
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<BrainSearchHit>, BrainError>;
  readonly history: (
    initiativeId: string,
    path: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<InitiativeBrainCommit>, BrainError>;
  /** The markdown files git tracks, with the commit that last changed each. */
  readonly pages: (
    initiativeId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly path: string; readonly commit: string | null }>,
    BrainError
  >;
  /** Commits what a crash left uncommitted; the commit, or null when nothing was left. */
  readonly recover: (initiativeId: string) => Effect.Effect<string | null, BrainError>;
}

// Never the user's hooks, signing or editor: the brain is written by the server.
const GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
  "-c",
  "core.quotePath=false",
];

export const makeBrainArchive = Effect.fn("BrainArchive.make")(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const writer = yield* Semaphore.make(1);

  const repoOf = (initiativeId: string) => path.join(rootDir, initiativeId, "brain");
  const fail = (message: string) => new BrainError({ message });

  const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    env?: Record<string, string>,
  ) =>
    runner
      .run({
        command,
        args,
        cwd,
        timeout: "30 seconds",
        ...(env ? { env } : {}),
      })
      .pipe(Effect.mapError((error) => fail(`${command} failed: ${error.message}`)));

  const git = (
    initiativeId: string,
    args: ReadonlyArray<string>,
    options: { readonly author?: InitiativeAuthor; readonly okCodes?: ReadonlyArray<number> } = {},
  ) =>
    Effect.gen(function* () {
      const identity = gitIdentityOf(options.author ?? "system:brain");
      const result = yield* run("git", [...GIT_CONFIG, ...args], repoOf(initiativeId), {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: "T3 Code",
        GIT_COMMITTER_EMAIL: "brain@initiatives.t3.local",
        GIT_TERMINAL_PROMPT: "0",
      });
      const okCodes = options.okCodes ?? [0];
      if (!okCodes.includes(Number(result.code ?? -1))) {
        return yield* fail(
          `git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? "unknown error"}`,
        );
      }
      return result;
    });

  const exists: BrainArchiveShape["exists"] = (initiativeId) =>
    fs.exists(path.join(repoOf(initiativeId), ".git")).pipe(Effect.orElseSucceed(() => false));

  const writeFile = (initiativeId: string, file: string, markdown: string) =>
    Effect.gen(function* () {
      const target = path.join(repoOf(initiativeId), file);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(target, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    }).pipe(Effect.mapError((error) => fail(`Could not write ${file}: ${error.message}`)));

  const head = (initiativeId: string) =>
    git(initiativeId, ["rev-parse", "HEAD"]).pipe(Effect.map((result) => result.stdout.trim()));

  const ensure: BrainArchiveShape["ensure"] = (initiativeId, pages, author) =>
    writer.withPermits(1)(
      Effect.gen(function* () {
        if (yield* exists(initiativeId)) return { created: false };
        const repo = repoOf(initiativeId);
        // Only the server's user reads the brain; it may hold what agents learned.
        yield* fs
          .makeDirectory(repo, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((error) => fail(`Could not create the brain: ${error.message}`)));
        yield* git(initiativeId, ["init", "-q"]);
        for (const page of pages) yield* writeFile(initiativeId, page.path, page.markdown);
        yield* git(initiativeId, ["add", "--", ...pages.map((page) => page.path)]);
        yield* git(initiativeId, ["commit", "-q", "-m", "Start the brain"], { author });
        return { created: true };
      }),
    );

  const read: BrainArchiveShape["read"] = (initiativeId, file) =>
    Effect.gen(function* () {
      const target = path.join(repoOf(initiativeId), file);
      if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) return null;
      return yield* fs
        .readFileString(target)
        .pipe(Effect.mapError((error) => fail(`Could not read ${file}: ${error.message}`)));
    });

  const write: BrainArchiveShape["write"] = (initiativeId, input) =>
    writer.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* exists(initiativeId))) return yield* fail("This initiative has no brain yet.");
        yield* writeFile(initiativeId, input.path, input.markdown);
        yield* git(initiativeId, ["add", "--", input.path]);
        // Exit 1: the page differs from its last commit.
        const diff = yield* git(initiativeId, ["diff", "--cached", "--quiet", "--", input.path], {
          okCodes: [0, 1],
        });
        if (Number(diff.code) === 0) return { commit: yield* head(initiativeId), changed: false };
        yield* git(initiativeId, ["commit", "-q", "-m", input.message, "--", input.path], {
          author: input.author,
        });
        return { commit: yield* head(initiativeId), changed: true };
      }),
    );

  const search: BrainArchiveShape["search"] = (initiativeId, query, limit) =>
    Effect.gen(function* () {
      const repo = repoOf(initiativeId);
      if (!(yield* exists(initiativeId))) return [];
      // ripgrep when the machine has it, git grep otherwise; both read the working tree.
      const ripgrep = yield* runner
        .run({
          command: "rg",
          args: [
            "--no-heading",
            "--line-number",
            "--ignore-case",
            "--fixed-strings",
            "--glob",
            "*.md",
            "--",
            query,
            ".",
          ],
          cwd: repo,
          timeout: "30 seconds",
        })
        .pipe(Effect.option);
      const output =
        ripgrep._tag === "Some" && ripgrep.value.code !== null && Number(ripgrep.value.code) <= 1
          ? ripgrep.value.stdout
          : (yield* git(initiativeId, ["grep", "-n", "-i", "-F", "-e", query, "--", "*.md"], {
              okCodes: [0, 1],
            })).stdout;
      const hits: Array<BrainSearchHit> = [];
      for (const line of output.split("\n")) {
        const match = /^(?:\.\/)?(.+?):(\d+):(.*)$/.exec(line);
        if (!match) continue;
        hits.push({
          path: match[1]!,
          line: Number(match[2]),
          text: match[3]!.trim().slice(0, 300),
        });
        if (hits.length >= limit) break;
      }
      return hits;
    });

  const history: BrainArchiveShape["history"] = (initiativeId, file, limit) =>
    Effect.gen(function* () {
      if (!(yield* exists(initiativeId))) return [];
      const result = yield* git(initiativeId, [
        "log",
        `-n${limit}`,
        "--format=%H%x1f%an%x1f%aI%x1f%s",
        "--",
        file,
      ]);
      return result.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [commit = "", author = "", at = "", message = ""] = line.split("\x1f");
          return { commit, author, at, message };
        });
    });

  const pages: BrainArchiveShape["pages"] = (initiativeId) =>
    Effect.gen(function* () {
      if (!(yield* exists(initiativeId))) return [];
      const files = (yield* git(initiativeId, ["ls-files", "--", "*.md"])).stdout
        .split("\n")
        .filter((line) => line.length > 0);
      return yield* Effect.forEach(files, (file) =>
        git(initiativeId, ["log", "-n1", "--format=%H", "--", file]).pipe(
          Effect.map((result) => ({ path: file, commit: result.stdout.trim() || null })),
        ),
      );
    });

  const recover: BrainArchiveShape["recover"] = (initiativeId) =>
    writer.withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* exists(initiativeId))) return null;
        const status = yield* git(initiativeId, ["status", "--porcelain", "--", "*.md"]);
        if (!status.stdout.trim()) return null;
        yield* git(initiativeId, ["add", "-A", "--", "*.md"]);
        yield* git(initiativeId, ["commit", "-q", "-m", "Recover changes left after a restart"], {
          author: "system:recover",
        });
        return yield* head(initiativeId);
      }),
    );

  return {
    ensure,
    exists,
    read,
    write,
    search,
    history,
    pages,
    recover,
  } satisfies BrainArchiveShape;
});
