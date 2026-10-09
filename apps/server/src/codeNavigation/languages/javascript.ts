// @effect-diagnostics nodeBuiltinImport:off
/** Fork: TypeScript, TSX and JavaScript for code navigation. */
import * as NodePath from "node:path";
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport, IndexedReExport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  type ModuleLinks,
  unquote,
  WORD_END,
} from "./shared.ts";

const JS_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(function_expression name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
(class name: (_) @name) @definition.class
(variable_declarator name: (identifier) @name) @definition.variable
(variable_declarator name: (object_pattern (shorthand_property_identifier_pattern) @name)) @definition.variable
(variable_declarator name: (object_pattern (pair_pattern value: (identifier) @name))) @definition.variable
(variable_declarator name: (array_pattern (identifier) @name)) @definition.variable
(method_definition name: (_) @name) @definition.method
(pair key: (property_identifier) @name) @definition.field
(arrow_function parameter: (identifier) @name) @definition.parameter
(catch_clause parameter: (identifier) @name) @definition.variable
(import_specifier alias: (identifier) @name) @definition.import
(import_specifier name: (identifier) @name !alias) @definition.import
(import_clause (identifier) @name) @definition.import
(namespace_import (identifier) @name) @definition.import
`;

const JS_ONLY_DEFINITIONS = `
(field_definition property: (_) @name) @definition.field
(formal_parameters (identifier) @name) @definition.parameter
(formal_parameters (assignment_pattern left: (identifier) @name)) @definition.parameter
(formal_parameters (object_pattern (shorthand_property_identifier_pattern) @name)) @definition.parameter
`;

const TS_ONLY_DEFINITIONS = `
(function_signature name: (identifier) @name) @definition.function
(abstract_class_declaration name: (_) @name) @definition.class
(interface_declaration name: (_) @name) @definition.interface
(type_alias_declaration name: (_) @name) @definition.type
(enum_declaration name: (_) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module
(module name: (identifier) @name) @definition.module
(method_signature name: (_) @name) @definition.method
(abstract_method_signature name: (_) @name) @definition.method
(public_field_definition name: (_) @name) @definition.field
(property_signature name: (_) @name) @definition.field
(enum_body (property_identifier) @name) @definition.field
(enum_assignment name: (_) @name) @definition.field
(required_parameter pattern: (identifier) @name) @definition.parameter
(optional_parameter pattern: (identifier) @name) @definition.parameter
(required_parameter pattern: (object_pattern (shorthand_property_identifier_pattern) @name)) @definition.parameter
(type_parameter name: (type_identifier) @name) @definition.typeParameter
`;

const JS_IDENTIFIERS = `
[
  (identifier)
  (property_identifier)
  (shorthand_property_identifier)
  (shorthand_property_identifier_pattern)
  (private_property_identifier)
] @id
(member_expression property: (_) @member)
`;

const TS_IDENTIFIERS = `
${JS_IDENTIFIERS}
(type_identifier) @id
(nested_type_identifier name: (type_identifier) @member)
`;

export const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function jsImportCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  if (!source.startsWith(".")) return [];
  const base = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(fromPath), source),
  );
  if (base.startsWith("..")) return [];
  const extension = NodePath.posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const candidates: string[] = [];
  if (JS_EXTENSIONS.includes(extension)) {
    candidates.push(base);
    // TypeScript's ESM style: `./a.js` names `./a.ts`.
    if (extension === ".js") candidates.push(`${stem}.ts`, `${stem}.tsx`);
    if (extension === ".jsx") candidates.push(`${stem}.tsx`);
    if (extension === ".mjs") candidates.push(`${stem}.mts`);
    if (extension === ".cjs") candidates.push(`${stem}.cts`);
  }
  for (const candidateExtension of JS_EXTENSIONS) candidates.push(`${base}${candidateExtension}`);
  for (const candidateExtension of JS_EXTENSIONS) {
    candidates.push(`${base}/index${candidateExtension}`);
  }
  return candidates;
}

function jsModuleLinks(root: TreeSitter.Node): ModuleLinks {
  const imports: IndexedImport[] = [];
  const reExports: IndexedReExport[] = [];
  let defaultExport: string | null = null;
  for (const statement of root.namedChildren) {
    if (!statement) continue;
    const sourceNode = statement.childForFieldName("source");
    const source = sourceNode ? unquote(sourceNode.text) : null;
    if (statement.type === "import_statement" && source !== null) {
      const clause = statement.namedChildren.find((child) => child?.type === "import_clause");
      for (const part of clause?.namedChildren ?? []) {
        if (!part) continue;
        if (part.type === "identifier") {
          imports.push({ local: part.text, imported: "default", source });
        } else if (part.type === "namespace_import") {
          const local = part.namedChildren.find((child) => child?.type === "identifier");
          if (local) imports.push({ local: local.text, imported: "*", source });
        } else if (part.type === "named_imports") {
          for (const specifier of part.namedChildren) {
            if (specifier?.type !== "import_specifier") continue;
            const name = specifier.childForFieldName("name")?.text;
            const alias = specifier.childForFieldName("alias")?.text;
            if (name) imports.push({ local: alias ?? name, imported: name, source });
          }
        }
      }
    } else if (statement.type === "export_statement") {
      const isDefault = statement.children.some((child) => child?.type === "default");
      if (source !== null) {
        const clause = statement.namedChildren.find((child) => child?.type === "export_clause");
        if (!clause) {
          reExports.push({ source, names: null });
        } else {
          const names = new Map<string, string>();
          for (const specifier of clause.namedChildren) {
            if (specifier?.type !== "export_specifier") continue;
            const name = specifier.childForFieldName("name")?.text;
            const alias = specifier.childForFieldName("alias")?.text;
            if (name) names.set(alias ?? name, name);
          }
          reExports.push({ source, names });
        }
      } else if (isDefault) {
        const declaration = statement.childForFieldName("declaration");
        const value = statement.childForFieldName("value");
        defaultExport =
          declaration?.childForFieldName("name")?.text ??
          (value?.type === "identifier" ? value.text : null);
      }
    }
  }
  return { imports, reExports, defaultExport };
}

function jsDefinitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\b[^;]*?(?<![\\p{L}\\p{N}_$.])${word}${WORD_END}`,
    `(^|[\\s,{(])(readonly\\s+|static\\s+|async\\s+|get\\s+|set\\s+|\\*)*#?${word}${WORD_END}\\s*(\\?|!)?\\s*[:=(<]`,
  );
}

const JS_SCOPES = [
  "program",
  "statement_block",
  "class_body",
  "for_statement",
  "for_in_statement",
  "catch_clause",
  "switch_body",
];
const JS_FUNCTIONS = [
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
  "function_signature",
  "method_signature",
  "abstract_method_signature",
  "call_signature",
  "construct_signature",
  "function_type",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
];

function jsLanguage(id: string, wasmFile: string, typescript: boolean): CodeNavigationLanguage {
  return {
    id,
    family: "js",
    wasmFile,
    definitionQuery: JS_DEFINITIONS + (typescript ? TS_ONLY_DEFINITIONS : JS_ONLY_DEFINITIONS),
    identifierQuery: typescript ? TS_IDENTIFIERS : JS_IDENTIFIERS,
    scopeTypes: new Set(JS_SCOPES),
    functionTypes: new Set(JS_FUNCTIONS),
    typeIdentifierTypes: new Set(["type_identifier"]),
    moduleLinks: jsModuleLinks,
    importCandidates: jsImportCandidates,
    definitionLine: jsDefinitionLine,
  };
}

export const TYPESCRIPT = jsLanguage("typescript", "tree-sitter-typescript.wasm", true);
export const TSX = jsLanguage("tsx", "tree-sitter-tsx.wasm", true);
export const JAVASCRIPT = jsLanguage("javascript", "tree-sitter-javascript.wasm", false);
