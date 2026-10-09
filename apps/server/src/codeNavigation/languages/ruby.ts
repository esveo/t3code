/**
 * Fork: Ruby for code navigation. Methods are found by name (a call without a
 * receiver may mean any method of the class or its ancestors);
 * `require_relative` and `require` rank the required file first.
 * `attr_reader` and friends do not define navigable names.
 */
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  directoryOf,
  escapeRegExp,
  fileImport,
  repositoryPath,
  stringLiteral,
  WORD_END,
} from "./shared.ts";

const DEFINITIONS = `
(method name: (_) @name) @definition.method
(singleton_method name: (_) @name) @definition.method
(class name: (constant) @name) @definition.class
(class name: (scope_resolution name: (constant) @name)) @definition.class
(module name: (constant) @name) @definition.module
(module name: (scope_resolution name: (constant) @name)) @definition.module
(assignment left: (constant) @name) @definition.constant
(assignment left: (identifier) @name) @definition.variable
(assignment left: (left_assignment_list (identifier) @name)) @definition.variable
(operator_assignment left: (identifier) @name) @definition.variable
(assignment left: [(instance_variable) (class_variable)] @name) @definition.field
(operator_assignment left: [(instance_variable) (class_variable)] @name) @definition.field
(assignment left: (global_variable) @name) @definition.variable
(for pattern: (identifier) @name) @definition.variable
(method_parameters (identifier) @name) @definition.parameter
(lambda_parameters (identifier) @name) @definition.parameter
(block_parameters (identifier) @name) @definition.parameter
(optional_parameter name: (identifier) @name) @definition.parameter
(splat_parameter name: (identifier) @name) @definition.parameter
(hash_splat_parameter name: (identifier) @name) @definition.parameter
(keyword_parameter name: (identifier) @name) @definition.parameter
(block_parameter name: (identifier) @name) @definition.parameter
`;

const IDENTIFIERS = `
[(identifier) (constant) (instance_variable) (class_variable) (global_variable)] @id
(call receiver: (_) method: (_) @member)
(scope_resolution scope: (_) name: (_) @member)
`;

const REQUIRES = new Set(["require", "require_relative", "load"]);

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const call of root.descendantsOfType("call")) {
    const method = call?.childForFieldName("method")?.text;
    if (!call || !method || !REQUIRES.has(method) || call.childForFieldName("receiver")) continue;
    const argument = call.childForFieldName("arguments")?.namedChildren[0];
    const source = argument?.type === "string" ? stringLiteral(argument) : null;
    if (source) imports.push(fileImport(method === "require_relative" ? `./${source}` : source));
  }
  return { imports, reExports: [], defaultExport: null };
}

function importCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  const withExtension = (path: string) => (path.endsWith(".rb") ? path : `${path}.rb`);
  // `require_relative` (recorded with `./`) is relative to the file; `require` to a load path.
  const paths = source.startsWith("./")
    ? [repositoryPath(directoryOf(fromPath), source)]
    : [repositoryPath("lib", source), repositoryPath(source)];
  return paths.filter((path): path is string => path !== null).map(withExtension);
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\bdef\\s+(self\\.)?${word}${WORD_END}`,
    `\\b(class|module)\\s+([\\p{L}\\p{N}_]+::)*${word}${WORD_END}`,
    `(^|[\\s,(])${word}${WORD_END}\\s*(\\|\\||&&|[-+*/])?=(?![=~>])`,
  );
}

export const RUBY: CodeNavigationLanguage = {
  id: "ruby",
  family: "ruby",
  wasmFile: "tree-sitter-ruby.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["program", "method", "singleton_method", "block", "do_block", "lambda"]),
  functionTypes: new Set(["method", "singleton_method", "block", "do_block", "lambda"]),
  implicitMembers: true,
  moduleLinks,
  importCandidates,
  definitionLine,
};
