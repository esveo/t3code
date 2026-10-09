/**
 * Fork: C++ and C for code navigation; the C++ grammar parses C well enough.
 * `#include "x.h"` only ranks the repository search: a name is found in the
 * included header (its declaration) and in the file that defines it.
 */
import type * as TreeSitter from "web-tree-sitter";

import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  relativeThenRoot,
  stringLiteral,
  WORD_END,
  WORD_START,
} from "./shared.ts";

/** `inner` below a pointer, reference or array declarator (`*x`, `&x`, `x[]`). */
const wrapped = (inner: string) =>
  `[(pointer_declarator declarator: ${inner}) (reference_declarator ${inner}) (array_declarator declarator: ${inner})]`;

const DEFINITIONS = `
(function_declarator declarator: (identifier) @name) @definition.function
(function_declarator declarator: (field_identifier) @name) @definition.method
(function_declarator declarator: (qualified_identifier name: (identifier) @name)) @definition.method
(function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (identifier) @name))) @definition.method
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(struct_specifier name: (type_identifier) @name body: (_)) @definition.struct
(union_specifier name: (type_identifier) @name body: (_)) @definition.struct
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
(alias_declaration name: (type_identifier) @name) @definition.type
(namespace_definition name: (namespace_identifier) @name) @definition.module
(preproc_def name: (identifier) @name) @definition.macro
(preproc_function_def name: (identifier) @name) @definition.macro
(enumerator name: (identifier) @name) @definition.constant
(field_declaration declarator: (field_identifier) @name) @definition.field
(field_declaration declarator: ${wrapped("(field_identifier) @name")}) @definition.field
(declaration declarator: (identifier) @name) @definition.variable
(declaration declarator: ${wrapped("(identifier) @name")}) @definition.variable
(init_declarator declarator: (identifier) @name) @definition.variable
(init_declarator declarator: ${wrapped("(identifier) @name")}) @definition.variable
(for_range_loop declarator: (identifier) @name) @definition.variable
(parameter_declaration declarator: (identifier) @name) @definition.parameter
(parameter_declaration declarator: ${wrapped("(identifier) @name")}) @definition.parameter
(optional_parameter_declaration declarator: (identifier) @name) @definition.parameter
(type_parameter_declaration (type_identifier) @name) @definition.typeParameter
`;

const IDENTIFIERS = `
[(identifier) (field_identifier) (type_identifier) (namespace_identifier)] @id
(field_expression field: (field_identifier) @member)
(qualified_identifier scope: (_) name: [(identifier) (type_identifier)] @member)
`;

function moduleLinks(root: TreeSitter.Node) {
  const imports = root
    .descendantsOfType("preproc_include")
    .map((include) => {
      const path = include?.childForFieldName("path");
      return path?.type === "string_literal" ? stringLiteral(path) : null;
    })
    .filter((source) => source !== null)
    .map(fileImport);
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(class|struct|union|enum|namespace|typedef|using)\\b.*${WORD_START}${word}${WORD_END}`,
    `#\\s*define\\s+${word}${WORD_END}`,
    `^[\\p{L}\\p{N}_:<>,*&\\s~]*[\\p{L}\\p{N}_>*&]\\s+[*&]*([\\p{L}\\p{N}_]+::)*${word}${WORD_END}\\s*[(\\[=;,{:)]`,
    `^\\s*${word}${WORD_END}\\s*(=|,|$)`,
  );
}

export const CPP: CodeNavigationLanguage = {
  id: "cpp",
  family: "c",
  wasmFile: "tree-sitter-cpp.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set([
    "translation_unit",
    "compound_statement",
    "for_statement",
    "for_range_loop",
    "catch_clause",
    "lambda_expression",
  ]),
  functionTypes: new Set([
    "function_definition",
    "declaration",
    "field_declaration",
    "lambda_expression",
    "template_declaration",
  ]),
  implicitMembers: true,
  moduleLinks,
  importCandidates: (fromPath, source) => [
    ...relativeThenRoot(fromPath, source),
    ...relativeThenRoot("", `include/${source}`),
  ],
  definitionLine,
};
