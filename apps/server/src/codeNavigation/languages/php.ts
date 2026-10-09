/**
 * Fork: PHP for code navigation. Variables keep their `$` (`$user`), so they
 * never collide with functions; a property drops it (`private $user` defines
 * the `user` of `$this->user`).
 * `use App\Models\User` ranks files ending in `Models/User.php` first;
 * `require`/`include` ranks the required file.
 */
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  pathSuffixes,
  relativeThenRoot,
  stringLiteral,
  WORD_END,
} from "./shared.ts";

const DEFINITIONS = `
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(enum_declaration name: (name) @name) @definition.enum
(enum_case name: (name) @name) @definition.field
(const_declaration (const_element (name) @name)) @definition.constant
(declaration_list (const_declaration (const_element (name) @name)) @definition.field)
(property_element name: (variable_name) @name) @definition.field
(property_promotion_parameter name: (variable_name) @name) @definition.field
(assignment_expression left: (variable_name) @name) @definition.variable
(foreach_statement (variable_name) @name @definition.variable)
(foreach_statement (pair (variable_name) @name @definition.variable))
(simple_parameter name: (variable_name) @name) @definition.parameter
(variadic_parameter name: (variable_name) @name) @definition.parameter
(namespace_use_clause (name) @name .) @definition.import
(namespace_use_clause alias: (name) @name) @definition.import
(namespace_use_clause (qualified_name (name) @name .) !alias) @definition.import
`;

const IDENTIFIERS = `
(variable_name) @id
(function_definition name: (name) @id)
(method_declaration name: (name) @id)
(class_declaration name: (name) @id)
(interface_declaration name: (name) @id)
(trait_declaration name: (name) @id)
(enum_declaration name: (name) @id)
(enum_case name: (name) @id)
(const_element (name) @id)
(function_call_expression function: (name) @id)
(object_creation_expression (name) @id)
(base_clause (name) @id)
(class_interface_clause (name) @id)
(named_type (name) @id)
(use_declaration (name) @id)
(namespace_use_clause (name) @id)
(qualified_name (name) @id .)
(scoped_call_expression scope: (name) @id)
(class_constant_access_expression . (name) @id)
(class_constant_access_expression (name) @id @member .)
(member_access_expression name: (name) @id @member)
(member_call_expression name: (name) @id @member)
(nullsafe_member_access_expression name: (name) @id @member)
(nullsafe_member_call_expression name: (name) @id @member)
(scoped_call_expression name: (name) @id @member)
`;

const REQUIRE_TYPES = [
  "require_expression",
  "require_once_expression",
  "include_expression",
  "include_once_expression",
];

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const node of root.descendantsOfType(["namespace_use_declaration", ...REQUIRE_TYPES])) {
    if (!node) continue;
    if (node.type !== "namespace_use_declaration") {
      // `require __DIR__ . '/x.php'` and `require 'x.php'`: the literal part is the path.
      const literal = node.descendantsOfType("string")[0];
      const source = stringLiteral(literal);
      if (source) imports.push(fileImport(source.replace(/^\//, "./")));
      continue;
    }
    const group = node.childForFieldName("body");
    const prefix = group
      ? node.namedChildren.find((child) => child?.type === "namespace_name")?.text
      : undefined;
    for (const clause of node.descendantsOfType("namespace_use_clause")) {
      if (!clause) continue;
      const path = clause.namedChildren.find(
        (child) => child?.type === "qualified_name" || child?.type === "name",
      );
      if (!path) continue;
      const full = prefix ? `${prefix}\\${path.text}` : path.text;
      const imported = full.split("\\").at(-1)!;
      const local = clause.childForFieldName("alias")?.text ?? imported;
      imports.push({ local, imported, source: full.replace(/^\\/, "") });
    }
  }
  return { imports, reExports: [], defaultExport: null };
}

function importCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  if (source.includes("\\")) {
    // PSR-4: the namespace's first segments map to a source folder, the rest to folders.
    return pathSuffixes(`${source.replaceAll("\\", "/")}.php`, 2);
  }
  return relativeThenRoot(fromPath, source);
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(function|class|interface|trait|enum|const|case)\\s+&?${word}${WORD_END}`,
    `\\b(public|private|protected|var|static|readonly)\\b[^;(]*\\$${word}${WORD_END}`,
    `^\\s*${word}${WORD_END}\\s*=(?!=)`,
  );
}

export const PHP: CodeNavigationLanguage = {
  id: "php",
  family: "php",
  wasmFile: "tree-sitter-php.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set([
    "program",
    "function_definition",
    "method_declaration",
    "anonymous_function",
    "arrow_function",
  ]),
  functionTypes: new Set([
    "function_definition",
    "method_declaration",
    "anonymous_function",
    "arrow_function",
  ]),
  memberSigil: "$",
  moduleLinks,
  importCandidates,
  definitionLine,
};
