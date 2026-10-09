// @effect-diagnostics nodeBuiltinImport:off
/** Fork: Python for code navigation. */
import * as NodePath from "node:path";
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import { anyOf, type CodeNavigationLanguage, escapeRegExp, WORD_END } from "./shared.ts";

const DEFINITIONS = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(class_definition body: (block (function_definition name: (identifier) @name) @definition.method))
(class_definition body: (block (decorated_definition definition: (function_definition name: (identifier) @name) @definition.method)))
(class_definition body: (block (expression_statement (assignment left: (identifier) @name) @definition.field)))
(assignment left: (identifier) @name) @definition.variable
(assignment left: (pattern_list (identifier) @name)) @definition.variable
(assignment left: (attribute object: (identifier) @_self attribute: (identifier) @name) (#eq? @_self "self")) @definition.field
(parameters (identifier) @name) @definition.parameter
(default_parameter name: (identifier) @name) @definition.parameter
(typed_parameter (identifier) @name) @definition.parameter
(typed_default_parameter name: (identifier) @name) @definition.parameter
(lambda_parameters (identifier) @name) @definition.parameter
(for_statement left: (identifier) @name) @definition.variable
(import_from_statement name: (dotted_name (identifier) @name)) @definition.import
(import_from_statement name: (aliased_import alias: (identifier) @name)) @definition.import
(import_statement name: (dotted_name . (identifier) @name)) @definition.import
(import_statement name: (aliased_import alias: (identifier) @name)) @definition.import
`;

const IDENTIFIERS = `
(identifier) @id
(attribute attribute: (identifier) @member)
`;

function importCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  const dots = /^\.*/.exec(source)?.[0].length ?? 0;
  const modulePath = source.slice(dots).split(".").filter(Boolean).join("/");
  let base = "";
  if (dots > 0) {
    base = NodePath.posix.dirname(fromPath);
    for (let level = 1; level < dots; level++) base = NodePath.posix.dirname(base);
    if (base === ".") base = "";
  }
  const joined = [base, modulePath].filter(Boolean).join("/");
  if (joined.length === 0) return [];
  return [`${joined}.py`, `${joined}/__init__.py`, `${joined}.pyi`];
}

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const statement of root.descendantsOfType(["import_from_statement", "import_statement"])) {
    if (!statement) continue;
    if (statement.type === "import_from_statement") {
      const source = statement.childForFieldName("module_name")?.text;
      if (!source) continue;
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        if (name.type === "aliased_import") {
          const imported = name.childForFieldName("name")?.text;
          const alias = name.childForFieldName("alias")?.text;
          if (imported && alias) imports.push({ local: alias, imported, source });
        } else {
          imports.push({ local: name.text, imported: name.text, source });
        }
      }
    } else {
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
        const alias = name.type === "aliased_import" ? name.childForFieldName("alias")?.text : null;
        if (!dotted) continue;
        imports.push({
          local: alias ?? dotted.text.split(".")[0]!,
          imported: "*",
          source: alias ? dotted.text : dotted.text.split(".")[0]!,
        });
      }
    }
  }
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(def|class)\\s+${word}${WORD_END}`,
    `(^|[\\s,(])${word}${WORD_END}\\s*(:|=(?!=))`,
    `self\\.${word}${WORD_END}\\s*=`,
  );
}

export const PYTHON: CodeNavigationLanguage = {
  id: "python",
  family: "python",
  wasmFile: "tree-sitter-python.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["module", "function_definition", "class_definition", "lambda"]),
  functionTypes: new Set(["function_definition", "lambda"]),
  moduleSeparator: ".",
  moduleLinks,
  importCandidates,
  definitionLine,
};
