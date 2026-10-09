/**
 * Fork: Bash (and sh/zsh scripts) for code navigation: functions and
 * variables. A variable is global unless declared `local`; `source x.sh` and
 * `. x.sh` rank the sourced file first.
 */
import type * as TreeSitter from "web-tree-sitter";

import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  relativeThenRoot,
  WORD_END,
  WORD_START,
} from "./shared.ts";

const DEFINITIONS = `
(function_definition name: (word) @name) @definition.function
(declaration_command "local" (variable_assignment name: (variable_name) @name)) @definition.local
(declaration_command "local" (variable_name) @name) @definition.local
(variable_assignment name: (variable_name) @name) @definition.variable
(for_statement variable: (variable_name) @name) @definition.variable
(declaration_command (variable_name) @name) @definition.variable
`;

const IDENTIFIERS = `
(variable_name) @id
(command_name (word) @id)
(function_definition name: (word) @id)
`;

/** A sourced path without its quotes and leading `$DIR/`-style prefix. */
function sourcedPath(argument: TreeSitter.Node): string | null {
  const text = argument.text.replace(/^["']|["']$/g, "");
  const path = text.replace(/^(\$\{?[\p{L}\p{N}_]+\}?|\$\([^)]*\))\//u, "./");
  return path.includes("$") ? null : path;
}

function moduleLinks(root: TreeSitter.Node) {
  const imports = root
    .descendantsOfType("command")
    .map((command) => {
      const name = command?.childForFieldName("name")?.text;
      const argument = command?.childForFieldName("argument");
      return (name === "source" || name === ".") && argument ? sourcedPath(argument) : null;
    })
    .filter((source) => source !== null)
    .map(fileImport);
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\bfunction\\s+${word}${WORD_END}`,
    `${WORD_START}${word}\\s*\\(\\s*\\)`,
    `(^|[\\s;])(export\\s+|local\\s+|readonly\\s+|declare\\s+(-\\w+\\s+)*)?${word}\\+?=`,
  );
}

export const BASH: CodeNavigationLanguage = {
  id: "bash",
  family: "shell",
  wasmFile: "tree-sitter-bash.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["program"]),
  functionTypes: new Set(["function_definition"]),
  moduleLinks,
  importCandidates: relativeThenRoot,
  definitionLine,
};
