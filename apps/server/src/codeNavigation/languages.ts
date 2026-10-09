// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: the languages code navigation understands. Adding one is adding an
 * entry here: the grammar's wasm file from `@vscode/tree-sitter-wasm`, a
 * definitions query in the style of the grammar's `tags.scm`, and how its
 * imports map to files.
 */
import * as NodePath from "node:path";

export type CodeNavigationLanguageId = "typescript" | "tsx" | "javascript" | "python";

/** Languages of one family see each other's files (a .ts file imports a .js file). */
export type CodeNavigationLanguageFamily = "js" | "python";

export interface CodeNavigationLanguage {
  readonly id: CodeNavigationLanguageId;
  readonly family: CodeNavigationLanguageFamily;
  /** File name in `@vscode/tree-sitter-wasm/wasm/`. */
  readonly wasmFile: string;
  /**
   * Captures `@name` with a `@definition.<kind>` around it, like tags.scm.
   * Kind `import` marks names an import brings into scope; they resolve
   * through the imported file instead of being a definition themselves.
   */
  readonly definitionQuery: string;
  /** Captures every navigable identifier as `@id`, and member accesses (`a.b`'s `b`) also as `@member`. */
  readonly identifierQuery: string;
  /** Nodes that open a scope for the definitions inside them. */
  readonly scopeTypes: ReadonlySet<string>;
  /** Nodes whose parameters are scoped to them. */
  readonly functionTypes: ReadonlySet<string>;
  /** Repository paths an import specifier may point at, in priority order; empty for packages. */
  readonly importCandidates: (fromPath: string, source: string) => ReadonlyArray<string>;
}

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

const PYTHON_DEFINITIONS = `
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

const PYTHON_IDENTIFIERS = `
(identifier) @id
(attribute attribute: (identifier) @member)
`;

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

function jsImportCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  if (!source.startsWith(".")) return [];
  const base = NodePath.posix.normalize(
    NodePath.posix.join(NodePath.posix.dirname(fromPath), source),
  );
  if (base.startsWith("..")) return [];
  const extension = NodePath.posix.extname(base);
  const stem = base.slice(0, base.length - extension.length);
  const candidates: string[] = [];
  if ((JS_EXTENSIONS as ReadonlyArray<string>).includes(extension)) {
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

function pythonImportCandidates(fromPath: string, source: string): ReadonlyArray<string> {
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

function jsLanguage(
  id: CodeNavigationLanguageId,
  wasmFile: string,
  typescript: boolean,
): CodeNavigationLanguage {
  return {
    id,
    family: "js",
    wasmFile,
    definitionQuery: JS_DEFINITIONS + (typescript ? TS_ONLY_DEFINITIONS : JS_ONLY_DEFINITIONS),
    identifierQuery: typescript ? TS_IDENTIFIERS : JS_IDENTIFIERS,
    scopeTypes: new Set(JS_SCOPES),
    functionTypes: new Set(JS_FUNCTIONS),
    importCandidates: jsImportCandidates,
  };
}

const TYPESCRIPT = jsLanguage("typescript", "tree-sitter-typescript.wasm", true);
const TSX = jsLanguage("tsx", "tree-sitter-tsx.wasm", true);
const JAVASCRIPT = jsLanguage("javascript", "tree-sitter-javascript.wasm", false);
const PYTHON: CodeNavigationLanguage = {
  id: "python",
  family: "python",
  wasmFile: "tree-sitter-python.wasm",
  definitionQuery: PYTHON_DEFINITIONS,
  identifierQuery: PYTHON_IDENTIFIERS,
  scopeTypes: new Set(["module", "function_definition", "class_definition", "lambda"]),
  functionTypes: new Set(["function_definition", "lambda"]),
  importCandidates: pythonImportCandidates,
};

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
};

export function languageForPath(path: string): CodeNavigationLanguage | null {
  if (path.endsWith(".d.ts")) return TYPESCRIPT;
  return LANGUAGE_BY_EXTENSION[NodePath.posix.extname(path).toLowerCase()] ?? null;
}

/** `git grep` pathspecs for every file of a family. */
export function familyPathspecs(family: CodeNavigationLanguageFamily): ReadonlyArray<string> {
  return Object.entries(LANGUAGE_BY_EXTENSION)
    .filter(([, language]) => language.family === family)
    .map(([extension]) => `*${extension}`);
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Lines that may declare `name`, to choose which `git grep` hits get parsed
 * when looking for a definition across the repository. Generous on purpose:
 * the parse decides, this only skips files that merely use the name.
 */
export function definitionLinePattern(family: CodeNavigationLanguageFamily, name: string): RegExp {
  const word = escapeRegExp(name);
  const after = "(?![\\p{L}\\p{N}_$])";
  if (family === "python") {
    return new RegExp(
      `\\b(def|class)\\s+${word}${after}|(^|[\\s,(])${word}${after}\\s*(:|=(?!=))|self\\.${word}${after}\\s*=`,
      "u",
    );
  }
  return new RegExp(
    [
      `\\b(function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\b[^;]*?(?<![\\p{L}\\p{N}_$.])${word}${after}`,
      `(^|[\\s,{(])(readonly\\s+|static\\s+|async\\s+|get\\s+|set\\s+|\\*)*#?${word}${after}\\s*(\\?|!)?\\s*[:=(<]`,
    ].join("|"),
    "u",
  );
}

/** Identifiers git grep can search for as a fixed word. */
export const isSearchableName = (name: string) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name);
