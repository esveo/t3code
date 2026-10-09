/**
 * Fork: CSS for code navigation: custom properties (`--x: …` and `var(--x)`),
 * and class and id selectors, where every rule naming one counts as its
 * definition. `@import` ranks the imported file first.
 */
import type * as TreeSitter from "web-tree-sitter";

import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  relativeThenRoot,
  stringLiteral,
} from "./shared.ts";

const DEFINITIONS = `
(declaration (property_name) @name (#match? @name "^--")) @definition.variable
(class_selector (class_name) @name) @definition.class
(id_selector (id_name) @name) @definition.id
`;

const IDENTIFIERS = `
(property_name) @id (#match? @id "^--")
(call_expression (function_name) @_function (arguments (plain_value) @id) (#eq? @_function "var") (#match? @id "^--"))
[(class_name) (id_name)] @id
`;

function moduleLinks(root: TreeSitter.Node) {
  const imports = root
    .descendantsOfType("import_statement")
    .map((statement) => {
      const target = statement?.namedChildren[0];
      if (target?.type === "string_value") return stringLiteral(target);
      // `@import url(x.css)`
      const argument = target?.type === "call_expression" ? target.lastNamedChild : null;
      return argument ? stringLiteral(argument.namedChildren[0] ?? argument) : null;
    })
    .filter((source) => source !== null && !/^[a-z]+:/i.test(source))
    .map((source) => fileImport(source!));
  return { imports, reExports: [], defaultExport: null };
}

const NAME_END = "(?![\\p{L}\\p{N}_-])";

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(`(^|[\\s;{])${word}\\s*:`, `[.#]${word}${NAME_END}`);
}

export const CSS: CodeNavigationLanguage = {
  id: "css",
  family: "css",
  wasmFile: "tree-sitter-css.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["stylesheet"]),
  functionTypes: new Set(),
  moduleLinks,
  importCandidates: relativeThenRoot,
  definitionLine,
};
