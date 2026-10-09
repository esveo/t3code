/**
 * Fork: Go for code navigation. A package is a directory, so imports only
 * rank the repository search (files in a directory the import path ends with
 * come first); the module path in go.mod is not read.
 */
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  pathSuffixes,
  WORD_END,
  WORD_START,
} from "./shared.ts";

const DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(method_elem name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name type: (_) @_type (#not-match? @_type "^(struct|interface) *[{]")) @definition.type
(type_alias name: (type_identifier) @name) @definition.type
(field_declaration name: (field_identifier) @name) @definition.field
(const_spec name: (identifier) @name) @definition.constant
(var_spec name: (identifier) @name) @definition.variable
(short_var_declaration left: (expression_list (identifier) @name)) @definition.variable
(range_clause left: (expression_list (identifier) @name)) @definition.variable
(parameter_declaration name: (identifier) @name) @definition.parameter
(variadic_parameter_declaration name: (identifier) @name) @definition.parameter
(type_parameter_declaration name: (identifier) @name) @definition.typeParameter
(import_spec name: (package_identifier) @name) @definition.import
`;

const IDENTIFIERS = `
[(identifier) (type_identifier) (field_identifier) (package_identifier)] @id
(selector_expression field: (field_identifier) @member)
(qualified_type name: (type_identifier) @member)
`;

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const spec of root.descendantsOfType("import_spec")) {
    const source = spec?.childForFieldName("path")?.text.replace(/^["`]|["`]$/g, "");
    if (!spec || !source) continue;
    const alias = spec.childForFieldName("name")?.text;
    if (alias === "_") continue;
    if (alias === ".") imports.push(fileImport(source));
    else imports.push({ local: alias ?? source.split("/").at(-1)!, imported: "*", source });
  }
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(func|type|var|const)\\b.*${WORD_START}${word}${WORD_END}`,
    `^\\s*${word}${WORD_END}`,
    `^\\s*[\\p{L}_][\\p{L}\\p{N}_]*\\s*,\\s*.*${WORD_START}${word}${WORD_END}`,
  );
}

export const GO: CodeNavigationLanguage = {
  id: "go",
  family: "go",
  wasmFile: "tree-sitter-go.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set([
    "source_file",
    "block",
    "func_literal",
    "for_statement",
    "if_statement",
    "expression_switch_statement",
    "type_switch_statement",
  ]),
  functionTypes: new Set(["function_declaration", "method_declaration", "func_literal"]),
  moduleLinks,
  importCandidates: (_fromPath, source) => pathSuffixes(source),
  definitionLine,
};
