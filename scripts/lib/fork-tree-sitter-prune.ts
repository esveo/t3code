/**
 * Fork: trims the tree-sitter packages of a staged runtime install to what code
 * navigation loads. web-tree-sitter is `require`d (its CommonJS build beside
 * `tree-sitter.wasm`); its debug build, C sources, source maps and types are
 * dead weight. `@vscode/tree-sitter-wasm` keeps only the grammars a language in
 * `apps/server/src/codeNavigation/languages.ts` references.
 */
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const pruneForkTreeSitter = Effect.fn("pruneForkTreeSitter")(function* (input: {
  readonly repoRoot: string;
  readonly nodeModulesDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Loaded by path: the server's sources are outside this script project.
  const languagesPath = path.join(input.repoRoot, "apps/server/src/codeNavigation/languages.ts");
  const { CODE_NAVIGATION_WASM_FILES } = yield* Effect.promise(
    () =>
      import(NodeURL.pathToFileURL(languagesPath).href) as Promise<{
        readonly CODE_NAVIGATION_WASM_FILES: ReadonlyArray<string>;
      }>,
  );
  const keep = {
    "web-tree-sitter": new Set(["package.json", "LICENSE", "tree-sitter.cjs", "tree-sitter.wasm"]),
    "@vscode/tree-sitter-wasm": new Set(["package.json", "LICENSE", "wasm"]),
    "@vscode/tree-sitter-wasm/wasm": new Set(CODE_NAVIGATION_WASM_FILES),
  };
  for (const [directory, entriesToKeep] of Object.entries(keep)) {
    const root = path.join(input.nodeModulesDir, directory);
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries.filter((entry) => !entriesToKeep.has(entry))) {
      yield* fs.remove(path.join(root, entry), { recursive: true, force: true });
    }
  }
});
