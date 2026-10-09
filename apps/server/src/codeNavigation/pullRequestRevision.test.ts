import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CodeNavigationRevision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodeNavigation from "./CodeNavigation.ts";
import { remoteForRepository } from "./pullRequestRevision.ts";

const TestLayer = CodeNavigation.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const UTIL = "export function helper(a: number) {\n  return a + 1;\n}\n";
const MAIN_BEFORE = 'import { helper } from "./util";\n\nexport const value = helper(1);\n';
const HELPERS = "export function helper(a: number) {\n  return a + 2;\n}\n";
const MAIN_AFTER = 'import { helper } from "./lib/helpers";\n\nexport const value = helper(2);\n';

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({ operation: "test.git", command: "git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const commitFiles = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string | null>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, contents] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      if (contents === null) {
        yield* fs.remove(absolute);
        continue;
      }
      yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
      yield* fs.writeFileString(absolute, contents);
    }
    yield* runGit(cwd, ["add", "-A"]);
    yield* runGit(cwd, ["commit", "--quiet", "-m", message]);
    return yield* runGit(cwd, ["rev-parse", "HEAD"]);
  });

/**
 * A bare "origin" hosting `acme/app`, and a clone of it taken before pull request #7 was pushed:
 * the pull request's two commits exist only on the remote.
 */
const makeRepositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "code-navigation-pr-test-" });
  const origin = `${root}/acme/app.git`;
  const author = `${root}/author`;
  const local = `${root}/local`;
  yield* fs.makeDirectory(origin, { recursive: true });
  yield* runGit(origin, ["init", "--quiet", "--bare", "--initial-branch=main"]);
  yield* runGit(root, ["clone", "--quiet", origin, author]);
  yield* runGit(author, ["config", "user.email", "test@example.com"]);
  yield* runGit(author, ["config", "user.name", "Test"]);
  const base = yield* commitFiles(author, "base", {
    "src/util.ts": UTIL,
    "src/main.ts": MAIN_BEFORE,
  });
  yield* runGit(author, ["push", "--quiet", "origin", "main"]);
  yield* runGit(root, ["clone", "--quiet", origin, local]);

  yield* runGit(author, ["checkout", "--quiet", "-b", "feature"]);
  const first = yield* commitFiles(author, "move helper", {
    "src/util.ts": null,
    "src/lib/helpers.ts": HELPERS,
    "src/main.ts": MAIN_BEFORE.replace("./util", "./lib/helpers"),
  });
  const head = yield* commitFiles(author, "use helper", { "src/main.ts": MAIN_AFTER });
  // Only the host's pull request ref carries the head, like a contributor's fork.
  yield* runGit(author, ["push", "--quiet", "origin", "HEAD:refs/pull/7/head"]);
  return { author, local, base, first, head };
});

const pullRequest = (
  side: "base" | "head",
  fields: { readonly headSha?: string; readonly commit?: string; readonly firstCommit?: string },
): CodeNavigationRevision => ({
  _tag: "pullRequest",
  side,
  repository: "acme/app",
  number: 7,
  baseBranch: "main",
  ...fields,
});

/** 1-based line and 0-based column of `needle` in `text`. */
function positionOf(text: string, needle: string) {
  const before = text.slice(0, text.indexOf(needle)).split("\n");
  return { line: before.length, column: before.at(-1)!.length };
}

describe("pull request revisions", () => {
  it("picks the remote that hosts the repository", () => {
    const remotes = [
      "mine\tgit@github.com:someone/app.git (fetch)",
      "mine\tgit@github.com:someone/app.git (push)",
      "upstream\thttps://github.com/Acme/App.git (fetch)",
      "alias\tgithub-work:acme/other (fetch)",
    ].join("\n");
    assert.strictEqual(remoteForRepository(remotes, "acme/app"), "upstream");
    assert.strictEqual(remoteForRepository(remotes, "acme/other"), "alias");
    assert.strictEqual(remoteForRepository(remotes, "acme/missing"), null);
  });

  it.effect("fetches a head missing from the clone, leaving its checkout alone", () =>
    Effect.gen(function* () {
      const { local, base, head } = yield* makeRepositories;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition({
        cwd: local,
        revision: pullRequest("head", { headSha: head }),
        path: "src/main.ts",
        ...positionOf(MAIN_AFTER, "helper(2)"),
      });
      assert.deepStrictEqual(
        result.definitions.map(({ path, line }) => ({ path, line })),
        [{ path: "src/lib/helpers.ts", line: 1 }],
      );
      assert.strictEqual(yield* runGit(local, ["rev-parse", "HEAD"]), base);
      assert.strictEqual(yield* runGit(local, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("resolves deleted lines at the merge base with the base branch", () =>
    Effect.gen(function* () {
      const { local, head } = yield* makeRepositories;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition({
        cwd: local,
        revision: pullRequest("base", { headSha: head }),
        path: "src/main.ts",
        ...positionOf(MAIN_BEFORE, "helper(1)"),
      });
      assert.deepStrictEqual(
        result.definitions.map(({ path, line }) => ({ path, line })),
        [{ path: "src/util.ts", line: 1 }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reads one commit against its parent, and the head from the remote when unknown", () =>
    Effect.gen(function* () {
      const { local, first } = yield* makeRepositories;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const atFirst = yield* navigation.readFile({
        cwd: local,
        revision: pullRequest("head", { commit: first }),
        path: "src/main.ts",
      });
      assert.include(atFirst.contents, "./lib/helpers");
      const beforeFirst = yield* navigation.readFile({
        cwd: local,
        revision: pullRequest("base", { commit: first }),
        path: "src/util.ts",
      });
      assert.strictEqual(beforeFirst.contents, UTIL);
      const listedHead = yield* navigation.readFile({
        cwd: local,
        revision: pullRequest("head", {}),
        path: "src/main.ts",
      });
      assert.strictEqual(listedHead.contents, MAIN_AFTER);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("falls back to the oldest commit's parent once the head is merged", () =>
    Effect.gen(function* () {
      const { author, local, base, first, head } = yield* makeRepositories;
      const navigation = yield* CodeNavigation.CodeNavigation;
      // Merged by a fast-forward: the head's merge base with main is the head itself.
      yield* runGit(author, ["push", "--quiet", "origin", "HEAD:main"]);
      const file = yield* navigation.readFile({
        cwd: local,
        revision: pullRequest("base", { headSha: head, firstCommit: first }),
        path: "src/util.ts",
      });
      assert.strictEqual(file.contents, UTIL);
      // The stale tracking ref was refreshed on the way.
      assert.strictEqual(yield* runGit(local, ["rev-parse", "origin/main"]), head);
      assert.notStrictEqual(base, head);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("offers nothing when the commits cannot be fetched", () =>
    Effect.gen(function* () {
      const { local } = yield* makeRepositories;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition({
        cwd: local,
        revision: pullRequest("head", { headSha: "f".repeat(40) }),
        path: "src/main.ts",
        ...positionOf(MAIN_AFTER, "helper(2)"),
      });
      assert.deepStrictEqual(result, { symbol: null, isDefinition: false, definitions: [] });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
