import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CodeNavigationRevision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CodeNavigation from "./CodeNavigation.ts";

const TestLayer = CodeNavigation.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OLD_FILES = {
  "src/util.ts": "export function helper(a: number) {\n  return a + 1;\n}\n",
  "src/main.ts": 'import { helper } from "./util";\n\nexport const value = helper(1);\n',
};

const MAIN = `import { helper } from "./lib/helpers";
import * as shapes from "./shapes";

function local(x: number) {
  const doubled = x * 2;
  return doubled + helper(x);
}

// helper is mentioned in a comment
export const value = local(1);
const label = "helper";
export function useShape(shape: shapes.Circle | shapes.Square) {
  return shape.area() + label.length;
}
`;

const NEW_FILES = {
  "src/lib/helpers.ts": "export function helper(a: number) {\n  return a + 2;\n}\n",
  "src/shapes.ts":
    "export class Circle {\n  area() {\n    return 1;\n  }\n}\n\nexport class Square {\n  area() {\n    return 2;\n  }\n}\n",
  "src/main.ts": MAIN,
  "py/models.py": "class User:\n    def __init__(self, name):\n        self.name = name\n",
  "py/app.py": "from .models import User\n\nuser = User('ada')\nprint(user.name)\n",
  "notes.txt": "helper is described here\n",
};

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (vcs) =>
    vcs.run({ operation: "test.git", command: "git", cwd, args, timeoutMs: 10_000 }),
  ).pipe(Effect.map((result) => result.stdout.trim()));

const writeFiles = (cwd: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const [file, contents] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, file), contents);
    }
  });

/** A repository with two commits: `helper` moves from src/util.ts to src/lib/helpers.ts. */
const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "code-navigation-test-" });
  yield* runGit(cwd, ["init", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test"]);
  yield* writeFiles(cwd, OLD_FILES);
  yield* runGit(cwd, ["add", "."]);
  yield* runGit(cwd, ["commit", "-m", "old"]);
  const oldCommit = yield* runGit(cwd, ["rev-parse", "HEAD"]);
  yield* fs.remove(`${cwd}/src/util.ts`);
  yield* writeFiles(cwd, NEW_FILES);
  yield* runGit(cwd, ["add", "-A"]);
  yield* runGit(cwd, ["commit", "-m", "new"]);
  const newCommit = yield* runGit(cwd, ["rev-parse", "HEAD"]);
  return { cwd, oldCommit, newCommit };
});

/** 1-based line and 0-based column of the `nth` occurrence of `needle` in `text`. */
function positionOf(text: string, needle: string, nth = 0) {
  let index = -1;
  for (let count = 0; count <= nth; count++) {
    index = text.indexOf(needle, index + 1);
    if (index === -1) throw new Error(`${needle} not found`);
  }
  const before = text.slice(0, index).split("\n");
  return { line: before.length, column: before.at(-1)!.length };
}

const at = (
  cwd: string,
  revision: CodeNavigationRevision,
  path: string,
  text: string,
  needle: string,
  nth = 0,
) => ({ cwd, revision, path, ...positionOf(text, needle, nth) });

const commit = (ref: string): CodeNavigationRevision => ({ _tag: "git", ref });

describe("CodeNavigation", () => {
  it.effect("finds a definition in the same file, scoped to its function", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "src/main.ts", MAIN, "doubled", 1),
      );
      assert.strictEqual(result.isDefinition, false);
      assert.deepStrictEqual(
        result.definitions.map(({ path, line, kind }) => ({ path, line, kind })),
        [{ path: "src/main.ts", line: 5, kind: "variable" }],
      );
      assert.deepStrictEqual(result.symbol, { name: "doubled", line: 6, column: 9, endColumn: 16 });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("follows an import into the imported file", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "src/main.ts", MAIN, "helper(x)"),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line, column, kind, preview }) => ({
          path,
          line,
          column,
          kind,
          preview,
        })),
        [
          {
            path: "src/lib/helpers.ts",
            line: 1,
            column: 16,
            kind: "function",
            preview: "export function helper(a: number) {",
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("returns every definition a member access may mean", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "src/main.ts", MAIN, "area"),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line, kind }) => ({ path, line, kind })),
        [
          { path: "src/shapes.ts", line: 2, kind: "method" },
          { path: "src/shapes.ts", line: 8, kind: "method" },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("resolves a namespace member through the namespace import", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "src/main.ts", MAIN, "Square"),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line, kind }) => ({ path, line, kind })),
        [{ path: "src/shapes.ts", line: 7, kind: "class" }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("marks a definition as such and finds its references, not comments or strings", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const helpers = NEW_FILES["src/lib/helpers.ts"];
      const position = at(cwd, commit(newCommit), "src/lib/helpers.ts", helpers, "helper");
      const definition = yield* navigation.resolveDefinition(position);
      assert.strictEqual(definition.isDefinition, true);
      const result = yield* navigation.findReferences(position);
      assert.deepStrictEqual(
        result.references.map(({ path, line, kind }) => ({ path, line, kind })),
        [
          { path: "src/lib/helpers.ts", line: 1, kind: "function" },
          { path: "src/main.ts", line: 1, kind: "import" },
          { path: "src/main.ts", line: 6, kind: "reference" },
        ],
      );
      assert.strictEqual(result.truncated, false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a local's references inside its scope", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const result = yield* navigation.findReferences(
        at(cwd, commit(newCommit), "src/main.ts", MAIN, "x:"),
      );
      assert.deepStrictEqual(
        result.references.map(({ line }) => line),
        [4, 5, 6],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("resolves at an old commit, where the symbol lived elsewhere", () =>
    Effect.gen(function* () {
      const { cwd, oldCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const main = OLD_FILES["src/main.ts"];
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(oldCommit), "src/main.ts", main, "helper", 1),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line }) => ({ path, line })),
        [{ path: "src/util.ts", line: 1 }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("resolves a deleted line at the parent revision", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      // The import line was removed by the latest commit; its old side is HEAD~1.
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit("HEAD~1"), "src/main.ts", OLD_FILES["src/main.ts"], "helper"),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line }) => ({ path, line })),
        [{ path: "src/util.ts", line: 1 }],
      );
      const file = yield* navigation.readFile({
        cwd,
        revision: commit("HEAD~1"),
        path: "src/util.ts",
      });
      assert.strictEqual(file.contents, OLD_FILES["src/util.ts"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reads the working tree for uncommitted changes", () =>
    Effect.gen(function* () {
      const { cwd } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const edited = `${MAIN}export function added() {\n  return local(2);\n}\n`;
      yield* writeFiles(cwd, { "src/main.ts": edited });
      const result = yield* navigation.resolveDefinition(
        at(cwd, { _tag: "workingTree" }, "src/main.ts", edited, "local", 2),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line }) => ({ path, line })),
        [{ path: "src/main.ts", line: 4 }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("follows a relative Python import", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const app = NEW_FILES["py/app.py"];
      const result = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "py/app.py", app, "User", 1),
      );
      assert.deepStrictEqual(
        result.definitions.map(({ path, line, kind }) => ({ path, line, kind })),
        [{ path: "py/models.py", line: 1, kind: "class" }],
      );
      const attribute = yield* navigation.resolveDefinition(
        at(cwd, commit(newCommit), "py/app.py", app, "name"),
      );
      assert.deepStrictEqual(
        attribute.definitions.map(({ path, line, kind }) => ({ path, line, kind })),
        [{ path: "py/models.py", line: 3, kind: "field" }],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("returns nothing for keywords, strings, comments and unsupported files", () =>
    Effect.gen(function* () {
      const { cwd, newCommit } = yield* makeRepository;
      const navigation = yield* CodeNavigation.CodeNavigation;
      const revision = commit(newCommit);
      for (const [needle, nth] of [
        ["function", 0],
        ['"helper"', 0],
        ["helper is", 0],
      ] as const) {
        const result = yield* navigation.resolveDefinition(
          at(cwd, revision, "src/main.ts", MAIN, needle, nth),
        );
        assert.deepStrictEqual(result, { symbol: null, isDefinition: false, definitions: [] });
      }
      const unsupported = yield* navigation.resolveDefinition(
        at(cwd, revision, "notes.txt", NEW_FILES["notes.txt"], "helper"),
      );
      assert.deepStrictEqual(unsupported, {
        symbol: null,
        isDefinition: false,
        definitions: [],
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
