// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: the languages code navigation understands, by file extension. Adding
 * one is a file in `languages/` (the grammar's wasm file from
 * `@vscode/tree-sitter-wasm`, definition and identifier queries in the style
 * of the grammar's `tags.scm`, how its imports map to files) and its
 * extensions here.
 */
import * as NodePath from "node:path";

import { BASH } from "./languages/bash.ts";
import { CPP } from "./languages/cpp.ts";
import { CSHARP } from "./languages/csharp.ts";
import { CSS } from "./languages/css.ts";
import { GO } from "./languages/go.ts";
import { JAVA } from "./languages/java.ts";
import { JAVASCRIPT, TSX, TYPESCRIPT } from "./languages/javascript.ts";
import { PHP } from "./languages/php.ts";
import { POWERSHELL } from "./languages/powershell.ts";
import { PYTHON } from "./languages/python.ts";
import { RUBY } from "./languages/ruby.ts";
import { RUST } from "./languages/rust.ts";
import type { CodeNavigationLanguage } from "./languages/shared.ts";

export type { CodeNavigationLanguage } from "./languages/shared.ts";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeNavigationLanguage>> = {
  ".ts": TYPESCRIPT,
  ".mts": TYPESCRIPT,
  ".cts": TYPESCRIPT,
  ".tsx": TSX,
  ".js": JAVASCRIPT,
  ".jsx": JAVASCRIPT,
  ".mjs": JAVASCRIPT,
  ".cjs": JAVASCRIPT,
  ".py": PYTHON,
  ".pyi": PYTHON,
  ".go": GO,
  ".rs": RUST,
  ".java": JAVA,
  ".cs": CSHARP,
  ".c": CPP,
  ".h": CPP,
  ".cc": CPP,
  ".cpp": CPP,
  ".cxx": CPP,
  ".c++": CPP,
  ".hh": CPP,
  ".hpp": CPP,
  ".hxx": CPP,
  ".php": PHP,
  ".rb": RUBY,
  ".rake": RUBY,
  ".sh": BASH,
  ".bash": BASH,
  ".zsh": BASH,
  ".ps1": POWERSHELL,
  ".psm1": POWERSHELL,
  ".css": CSS,
};

export function languageForPath(path: string): CodeNavigationLanguage | null {
  if (path.endsWith(".d.ts")) return TYPESCRIPT;
  return LANGUAGE_BY_EXTENSION[NodePath.posix.extname(path).toLowerCase()] ?? null;
}

/** `git grep` pathspecs for every file of a family. */
export function familyPathspecs(family: string): ReadonlyArray<string> {
  return Object.entries(LANGUAGE_BY_EXTENSION)
    .filter(([, language]) => language.family === family)
    .map(([extension]) => `*${extension}`);
}

/** The grammar files code navigation loads; the server package ships only these. */
export const CODE_NAVIGATION_WASM_FILES: ReadonlyArray<string> = [
  ...new Set(Object.values(LANGUAGE_BY_EXTENSION).map((language) => language.wasmFile)),
];

/**
 * Names git grep can search for as a fixed word: identifiers, optionally with
 * a sigil (`$x`, `@x`, `--x`) and inner hyphens (`Get-Item`, `btn-primary`).
 */
export const isSearchableName = (name: string) =>
  /^(\$|@@?|--?)?[\p{L}_$][\p{L}\p{N}_$-]*$/u.test(name);
