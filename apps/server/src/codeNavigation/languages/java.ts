/**
 * Fork: Java for code navigation. Imports name classes, not files; the
 * repository search finds them and ranks files whose path ends with the
 * imported package path first.
 */
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  WORD_END,
  WORD_START,
} from "./shared.ts";

const DEFINITIONS = `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(annotation_type_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field
(constant_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.field
(enum_constant name: (identifier) @name) @definition.field
(local_variable_declaration declarator: (variable_declarator name: (identifier) @name)) @definition.variable
(enhanced_for_statement name: (identifier) @name) @definition.variable
(catch_formal_parameter name: (identifier) @name) @definition.variable
(resource name: (identifier) @name) @definition.variable
(formal_parameter name: (identifier) @name) @definition.parameter
(spread_parameter (variable_declarator name: (identifier) @name)) @definition.parameter
(lambda_expression parameters: (identifier) @name) @definition.parameter
(inferred_parameters (identifier) @name) @definition.parameter
(type_parameter (type_identifier) @name) @definition.typeParameter
`;

const IDENTIFIERS = `
[(identifier) (type_identifier)] @id
(field_access field: (identifier) @member)
(method_invocation object: (_) name: (identifier) @member)
(method_reference (_) (identifier) @member .)
`;

/** `com.example.Foo` → `com/example/Foo.java`, matched as a path suffix. */
const importCandidates = (_fromPath: string, source: string): ReadonlyArray<string> =>
  source ? [`${source.replaceAll(".", "/")}.java`] : [];

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const declaration of root.namedChildren) {
    if (declaration?.type !== "import_declaration") continue;
    const path = declaration.namedChildren.find(
      (child) => child?.type === "scoped_identifier" || child?.type === "identifier",
    );
    if (!path) continue;
    const isStatic = declaration.children.some((child) => child?.type === "static");
    if (declaration.namedChildren.some((child) => child?.type === "asterisk")) {
      // `import a.b.*` brings a package's classes; a static one a class's members.
      if (isStatic) imports.push(fileImport(path.text));
      continue;
    }
    const segments = path.text.split(".");
    const name = segments.at(-1)!;
    // A static import names a member of the class before it.
    const source = isStatic ? segments.slice(0, -1).join(".") : path.text;
    imports.push({ local: name, imported: name, source });
  }
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(class|interface|enum|record|@interface)\\s+${word}${WORD_END}`,
    `[\\p{L}\\p{N}_>\\]?]\\s+${WORD_START}${word}${WORD_END}\\s*[(=;,]`,
    `^\\s*${word}${WORD_END}\\s*([(,;{]|$)`,
  );
}

export const JAVA: CodeNavigationLanguage = {
  id: "java",
  family: "java",
  wasmFile: "tree-sitter-java.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set([
    "program",
    "block",
    "constructor_body",
    "for_statement",
    "enhanced_for_statement",
    "catch_clause",
    "try_with_resources_statement",
    "lambda_expression",
    "switch_block",
  ]),
  functionTypes: new Set([
    "method_declaration",
    "constructor_declaration",
    "lambda_expression",
    "record_declaration",
    "class_declaration",
    "interface_declaration",
  ]),
  implicitMembers: true,
  moduleLinks,
  importCandidates,
  definitionLine,
};
