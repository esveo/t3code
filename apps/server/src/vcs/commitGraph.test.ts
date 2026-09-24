import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { commitGraphLogArgs, parseCommitGraphLog } from "./commitGraphLog.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-commit-graph-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const FIELD = "";
const RECORD = "";

const record = (fields: ReadonlyArray<string>) => fields.join(FIELD) + RECORD;

describe("parseCommitGraphLog", () => {
  it("reads parents, decorations and author out of one record", () => {
    const [commit] = parseCommitGraphLog(
      record([
        "abc123",
        "def456 789abc",
        "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1",
        "Ada",
        "2026-09-18T10:00:00+02:00",
        "feat: thing",
      ]),
    );
    assert.deepStrictEqual(commit, {
      sha: "abc123",
      parents: ["def456", "789abc"],
      refs: [
        { kind: "head", name: "main" },
        { kind: "remote", name: "origin/main" },
        { kind: "tag", name: "v1" },
      ],
      author: "Ada",
      authoredAt: "2026-09-18T10:00:00+02:00",
      subject: "feat: thing",
    });
  });

  it("tells a local branch apart from a remote one with the same short name", () => {
    const [commit] = parseCommitGraphLog(
      record([
        "abc123",
        "",
        "refs/heads/feature/x, refs/remotes/origin/feature/x",
        "Ada",
        "2026-09-18T10:00:00+02:00",
        "work",
      ]),
    );
    assert.deepStrictEqual(commit?.refs, [
      { kind: "branch", name: "feature/x" },
      { kind: "remote", name: "origin/feature/x" },
    ]);
  });

  it("drops T3 checkpoint refs from the decorations of a commit that keeps others", () => {
    const [commit] = parseCommitGraphLog(
      record([
        "abc123",
        "",
        "refs/heads/main, refs/t3/checkpoints/thread/turn/0",
        "Ada",
        "2026-09-18T10:00:00+02:00",
        "work",
      ]),
    );
    assert.deepStrictEqual(commit?.refs, [{ kind: "branch", name: "main" }]);
  });

  it("keeps a root commit's empty parent list and undecorated refs empty", () => {
    const [commit] = parseCommitGraphLog(
      record(["abc123", "", "", "Ada", "2026-09-18T10:00:00+02:00", "initial"]),
    );
    assert.deepStrictEqual(commit?.parents, []);
    assert.deepStrictEqual(commit?.refs, []);
  });

  it("keeps a subject that contains the field separator intact", () => {
    const [commit] = parseCommitGraphLog(
      record(["abc123", "", "", "Ada", "2026-09-18T10:00:00+02:00", `weird${FIELD}subject`]),
    );
    assert.strictEqual(commit?.subject, `weird${FIELD}subject`);
  });

  it("drops the trailing empty record instead of emitting a blank commit", () => {
    const commits = parseCommitGraphLog(
      record(["a".repeat(40), "", "", "Ada", "2026-09-18T10:00:00+02:00", "one"]) +
        "\n" +
        record(["b".repeat(40), "a".repeat(40), "", "Ada", "2026-09-18T09:00:00+02:00", "two"]) +
        "\n",
    );
    assert.strictEqual(commits.length, 2);
  });

  it("asks Git for one commit past the window so the view knows there is more", () => {
    const args = commitGraphLogArgs({ limit: 40 });
    assert.ok(args.includes("--max-count=41"));
    assert.ok(args.includes("--decorate=full"), "short decorations could not be classified");
    // `--exclude` only applies to the globs after it, so it has to precede `--all`.
    assert.ok(args.indexOf("--exclude=refs/t3/*") < args.indexOf("--all"));
  });
});

const makeTmpDir = (): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "commit-graph-test-" });
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return result.stdout.trim();
  });

/** Each commit touches its own file, so the merge in the fixture stays conflict-free. */
const commit = (cwd: string, message: string, env?: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const fileName = `${message.replace(/\s+/g, "-")}.txt`;
    yield* fileSystem.writeFileString(pathService.join(cwd, fileName), `${message}\n`);
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", message], env);
  });

/** main: initial -> a -> merge(side), plus a T3 checkpoint ref off to the side. */
const makeRepositoryWithHistory = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* commit(cwd, "initial");
    const mainBranch = yield* git(cwd, ["branch", "--show-current"]);
    yield* git(cwd, ["checkout", "-b", "side"]);
    yield* commit(cwd, "side work");
    yield* git(cwd, ["checkout", mainBranch]);
    yield* commit(cwd, "main work");
    yield* git(cwd, ["merge", "--no-ff", "-m", "merge side", "side"]);
    // A checkpoint as T3 writes it: a parentless commit behind a hidden ref.
    const tree = yield* git(cwd, ["write-tree"]);
    const checkpoint = yield* git(cwd, ["commit-tree", tree, "-m", "t3 checkpoint turn/0"]);
    yield* git(cwd, ["update-ref", "refs/t3/checkpoints/thread/turn/0", checkpoint]);
    return { mainBranch, checkpointSha: checkpoint };
  });

describe("listCommitGraph", () => {
  it.effect("returns commits with their parents and never the T3 checkpoints", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { mainBranch, checkpointSha } = yield* makeRepositoryWithHistory(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const graph = yield* driver.listCommitGraph({ cwd });

      assert.strictEqual(graph.isRepo, true);
      assert.strictEqual(graph.currentRefName, mainBranch);
      const subjects = graph.commits.map((entry) => entry.subject);
      // The two branch commits share a timestamp, so only their position
      // between the merge and the root commit is meaningful.
      assert.strictEqual(subjects[0], "merge side");
      assert.strictEqual(subjects[3], "initial");
      assert.deepStrictEqual(subjects.slice(1, 3).toSorted(), ["main work", "side work"]);
      const merge = graph.commits[0];
      assert.strictEqual(merge?.parents.length, 2, "the merge keeps both parents");
      assert.strictEqual(merge?.sha, graph.headSha);
      assert.ok(
        !graph.commits.some((entry) => entry.sha === checkpointSha),
        "checkpoint commits stay out of the graph",
      );
      assert.ok(
        graph.commits.some((entry) => entry.refs.some((ref) => ref.kind === "head")),
        "HEAD is decorated so the view can mark the current branch",
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports more behind a window and returns it once the window grows", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* makeRepositoryWithHistory(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const firstPage = yield* driver.listCommitGraph({ cwd, limit: 2 });
      assert.strictEqual(firstPage.commits.length, 2);
      assert.strictEqual(firstPage.hasMore, true);

      const grown = yield* driver.listCommitGraph({ cwd, limit: 10 });
      assert.strictEqual(grown.hasMore, false);
      assert.strictEqual(grown.commits.at(-1)?.subject, "initial");
      assert.deepStrictEqual(grown.commits.map((entry) => entry.subject).toSorted(), [
        "initial",
        "main work",
        "merge side",
        "side work",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("lists every child above its parents when commits share a second", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      const sameSecond = {
        GIT_AUTHOR_DATE: "2026-01-01T10:00:00Z",
        GIT_COMMITTER_DATE: "2026-01-01T10:00:00Z",
      };
      // Without an explicit order, `git log --all` walks this history as
      // p, z, a, y, root: `a` comes out before its child `y`.
      yield* commit(cwd, "root", sameSecond);
      yield* commit(cwd, "a", sameSecond);
      const base = yield* git(cwd, ["branch", "--show-current"]);
      yield* git(cwd, ["checkout", "-b", "y-branch"]);
      yield* commit(cwd, "y", sameSecond);
      yield* git(cwd, ["checkout", base]);
      yield* commit(cwd, "p", sameSecond);
      yield* git(cwd, ["tag", "v1"]);
      yield* git(cwd, ["checkout", "y-branch"]);
      yield* commit(cwd, "z", sameSecond);

      const graph = yield* driver.listCommitGraph({ cwd });

      const rowOf = new Map(graph.commits.map((entry, index) => [entry.sha, index]));
      for (const entry of graph.commits) {
        for (const parent of entry.parents) {
          assert.ok(
            (rowOf.get(parent) ?? Infinity) > (rowOf.get(entry.sha) ?? -1),
            `${entry.subject} sits above its parent`,
          );
        }
      }
      const tagged = graph.commits.find((entry) => entry.subject === "p");
      assert.deepStrictEqual(
        tagged?.refs.filter((ref) => ref.kind === "tag"),
        [{ kind: "tag", name: "v1" }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("answers for a directory that is not a repository instead of failing", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const graph = yield* driver.listCommitGraph({ cwd });

      assert.deepStrictEqual(graph, {
        commits: [],
        hasMore: false,
        isRepo: false,
        headSha: null,
        currentRefName: null,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
