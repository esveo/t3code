// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: what a language tells code navigation, and helpers the language
 * files share. Each language lives in its own file next to this one.
 */
import * as NodePath from "node:path";
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport, IndexedReExport } from "../fileIndex.ts";

export interface ModuleLinks {
  readonly imports: ReadonlyArray<IndexedImport>;
  readonly reExports: ReadonlyArray<IndexedReExport>;
  /** The identifier `export default` names, if any. */
  readonly defaultExport: string | null;
}

export interface CodeNavigationLanguage {
  readonly id: string;
  /** Languages of one family see each other's files (a .ts file imports a .js file). */
  readonly family: string;
  /** File name in `@vscode/tree-sitter-wasm/wasm/`. */
  readonly wasmFile: string;
  /**
   * Captures `@name` with a `@definition.<kind>` around it, like tags.scm.
   * Kind `import` marks names an import brings into scope; they resolve
   * through the imported file instead of being a definition themselves.
   */
  readonly definitionQuery: string;
  /**
   * Captures every navigable identifier as `@id`, and member accesses (`a.b`'s
   * `b`) also as `@member`. Captures starting with `_` only feed predicates.
   */
  readonly identifierQuery: string;
  /** Nodes that open a scope for the definitions inside them. */
  readonly scopeTypes: ReadonlySet<string>;
  /** Nodes whose parameters (and other function-local kinds) are scoped to them. */
  readonly functionTypes: ReadonlySet<string>;
  /**
   * Identifier nodes that name a type rather than a value (TypeScript's
   * `type_identifier`). Omitted when the grammar does not tell them apart
   * reliably; then any kind of definition fits any occurrence.
   */
  readonly typeIdentifierTypes?: ReadonlySet<string>;
  /** An unqualified name may mean a member of the enclosing class (an implicit `this`). */
  readonly implicitMembers?: boolean;
  /** Dropped from a member's definition (PHP's `private $x` defines the `x` of `$this->x`). */
  readonly memberSigil?: string;
  /** Separator of module paths (Python `.`, Rust `::`): an imported name may itself be a module. */
  readonly moduleSeparator?: string;
  /** Imports, re-exports and the default export of a parsed file. */
  readonly moduleLinks: (root: TreeSitter.Node) => ModuleLinks;
  /**
   * Repository paths an import specifier may point at, in priority order;
   * empty for packages. A candidate may also be a directory (a Go package) or
   * a path suffix (a Java package); both only rank search results.
   */
  readonly importCandidates: (fromPath: string, source: string) => ReadonlyArray<string>;
  /**
   * Lines that may declare `name`, to choose which `git grep` hits get parsed
   * when looking for a definition across the repository. Generous on purpose:
   * the parse decides, this only skips files that merely use the name.
   */
  readonly definitionLine: (name: string) => RegExp;
}

export const NO_MODULE_LINKS: ModuleLinks = { imports: [], reExports: [], defaultExport: null };

export const noImportCandidates = (): ReadonlyArray<string> => [];

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lookahead: the name ends here. */
export const WORD_END = "(?![\\p{L}\\p{N}_$])";
/** Lookbehind: the name starts here. */
export const WORD_START = "(?<![\\p{L}\\p{N}_$])";

/** A unicode regexp from alternatives. */
export const anyOf = (...alternatives: ReadonlyArray<string>) =>
  new RegExp(alternatives.join("|"), "u");

export const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, "");

/** `dirname`, with `""` for the repository root. */
export const directoryOf = (path: string) => {
  const directory = NodePath.posix.dirname(path);
  return directory === "." ? "" : directory;
};

/**
 * Joins repository path parts; null when the result leaves the repository.
 */
export function repositoryPath(...parts: ReadonlyArray<string>): string | null {
  const joined = NodePath.posix.normalize(parts.filter(Boolean).join("/"));
  if (joined === "." || joined.startsWith("../") || joined === "..") return null;
  return joined.replace(/^\.\//, "").replace(/^\//, "");
}

/** A path relative to the importing file's directory, then to the repository root. */
export function relativeThenRoot(fromPath: string, source: string): ReadonlyArray<string> {
  const stripped = source.replace(/^\.\//, "");
  return [repositoryPath(directoryOf(fromPath), stripped), repositoryPath(stripped)].filter(
    (path): path is string => path !== null,
  );
}

/** Every suffix of a slash path, longest first: `a/b/c` → `a/b/c`, `b/c`, `c`. */
export function pathSuffixes(path: string, minimumSegments = 1): ReadonlyArray<string> {
  const segments = path.split("/").filter(Boolean);
  const suffixes: string[] = [];
  for (let start = 0; start <= segments.length - minimumSegments; start++) {
    suffixes.push(segments.slice(start).join("/"));
  }
  return suffixes;
}

/** An import that brings in a whole file without one name (`#include`, `require_relative`). */
export const fileImport = (source: string): IndexedImport => ({
  local: "",
  imported: "*",
  source,
});

/** The text of a string literal node without its quotes, or null when it interpolates. */
export function stringLiteral(node: TreeSitter.Node | null | undefined): string | null {
  if (!node) return null;
  const parts = node.namedChildren.filter((child) => child !== null);
  if (parts.length === 0) return unquote(node.text);
  if (parts.length === 1 && parts[0]!.type.endsWith("content")) return parts[0]!.text;
  return null;
}
