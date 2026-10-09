// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: Rust for code navigation. `mod x;` and `use crate::…`, `self::…`,
 * `super::…` resolve to module files by Rust's file layout (`x.rs` or
 * `x/mod.rs`, the crate root being the nearest `src/`); other crates fall
 * back to the repository search.
 */
import * as NodePath from "node:path";
import type * as TreeSitter from "web-tree-sitter";

import type { IndexedImport } from "../fileIndex.ts";
import {
  anyOf,
  type CodeNavigationLanguage,
  directoryOf,
  escapeRegExp,
  fileImport,
  repositoryPath,
  WORD_END,
} from "./shared.ts";

const DEFINITIONS = `
(function_item name: (identifier) @name) @definition.function
(impl_item body: (declaration_list (function_item name: (identifier) @name) @definition.method))
(trait_item body: (declaration_list (function_item name: (identifier) @name) @definition.method))
(trait_item body: (declaration_list (function_signature_item name: (identifier) @name) @definition.method))
(function_signature_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(union_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(type_item name: (type_identifier) @name) @definition.type
(associated_type name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(macro_definition name: (identifier) @name) @definition.macro
(mod_item name: (identifier) @name body: (_)) @definition.module
(mod_item name: (identifier) @name !body) @definition.import
(field_declaration name: (field_identifier) @name) @definition.field
(enum_variant name: (identifier) @name) @definition.field
(let_declaration pattern: (identifier) @name) @definition.variable
(let_declaration pattern: (mut_pattern (identifier) @name)) @definition.variable
(let_declaration pattern: (tuple_pattern (identifier) @name)) @definition.variable
(for_expression pattern: (identifier) @name @definition.variable)
(parameter pattern: (identifier) @name) @definition.parameter
(parameter pattern: (mut_pattern (identifier) @name)) @definition.parameter
(closure_parameters (identifier) @name) @definition.parameter
(type_parameter name: (type_identifier) @name) @definition.typeParameter
(use_declaration argument: (identifier) @name) @definition.import
(use_declaration argument: (scoped_identifier name: (identifier) @name)) @definition.import
(use_as_clause alias: (identifier) @name) @definition.import
(use_list (identifier) @name) @definition.import
(use_list (scoped_identifier name: (identifier) @name)) @definition.import
`;

const IDENTIFIERS = `
[(identifier) (type_identifier) (field_identifier) (shorthand_field_identifier)] @id
(field_expression field: (field_identifier) @member)
(scoped_identifier path: (_) name: (identifier) @member)
(scoped_type_identifier path: (_) name: (type_identifier) @member)
(field_initializer field: (field_identifier) @member)
(field_pattern name: (field_identifier) @member)
`;

/** The directory holding the child modules of the module `path` defines. */
function moduleDirectory(path: string): string {
  const base = NodePath.posix.basename(path);
  return ["lib.rs", "main.rs", "mod.rs"].includes(base)
    ? directoryOf(path)
    : path.slice(0, -".rs".length);
}

/** The crate's root directory: the nearest `src` above the file. */
function crateRoot(path: string): string {
  const segments = path.split("/").slice(0, -1);
  const src = segments.lastIndexOf("src");
  return src === -1 ? directoryOf(path) : segments.slice(0, src + 1).join("/");
}

/** The files that may define the module whose children live in `directory`. */
function moduleFiles(directory: string, root: string): ReadonlyArray<string> {
  if (directory === root) {
    return [repositoryPath(root, "lib.rs"), repositoryPath(root, "main.rs")].filter(
      (path): path is string => path !== null,
    );
  }
  return [`${directory}.rs`, `${directory}/mod.rs`];
}

function importCandidates(fromPath: string, source: string): ReadonlyArray<string> {
  const segments = source.split("::").filter(Boolean);
  const root = crateRoot(fromPath);
  const bases: string[] = [];
  let rest = segments;
  if (segments[0] === "crate") {
    bases.push(root);
    rest = segments.slice(1);
  } else if (segments[0] === "self" || segments[0] === "super") {
    let directory = moduleDirectory(fromPath);
    if (segments[0] === "self") rest = segments.slice(1);
    while (rest[0] === "super") {
      directory = directoryOf(directory);
      rest = rest.slice(1);
    }
    bases.push(directory);
  } else {
    // A module next to this one, or one at the crate root.
    bases.push(moduleDirectory(fromPath), root);
  }
  return bases.flatMap((base) => {
    if (rest.length === 0) return moduleFiles(base, root);
    const target = repositoryPath(base, ...rest);
    return target ? [`${target}.rs`, `${target}/mod.rs`] : [];
  });
}

const pathText = (node: TreeSitter.Node | null) =>
  node && ["identifier", "scoped_identifier", "crate", "self", "super"].includes(node.type)
    ? node.text.replace(/\s+/g, "")
    : null;

const joinPath = (prefix: string, path: string) => (prefix ? `${prefix}::${path}` : path);

/** One `use` tree, below the path `prefix`. */
function collectUse(node: TreeSitter.Node, prefix: string, imports: IndexedImport[]) {
  switch (node.type) {
    case "identifier":
      if (prefix) imports.push({ local: node.text, imported: node.text, source: prefix });
      return;
    case "self": {
      const local = prefix.split("::").at(-1);
      if (local) imports.push({ local, imported: "*", source: prefix });
      return;
    }
    case "scoped_identifier": {
      const path = pathText(node.childForFieldName("path"));
      const name = node.childForFieldName("name")?.text;
      if (path !== null && name) {
        imports.push({ local: name, imported: name, source: joinPath(prefix, path) });
      }
      return;
    }
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const alias = node.childForFieldName("alias")?.text;
      if (!path || !alias) return;
      const collected: IndexedImport[] = [];
      collectUse(path, prefix, collected);
      for (const binding of collected) imports.push({ ...binding, local: alias });
      return;
    }
    case "scoped_use_list": {
      const path = pathText(node.childForFieldName("path"));
      const list = node.childForFieldName("list");
      const next = path === null ? prefix : joinPath(prefix, path);
      for (const child of list?.namedChildren ?? []) if (child) collectUse(child, next, imports);
      return;
    }
    case "use_list":
      for (const child of node.namedChildren) if (child) collectUse(child, prefix, imports);
      return;
    case "use_wildcard": {
      const path = pathText(node.namedChildren[0] ?? null);
      imports.push(fileImport(path === null ? prefix : joinPath(prefix, path)));
      return;
    }
  }
}

function moduleLinks(root: TreeSitter.Node) {
  const imports: IndexedImport[] = [];
  for (const item of root.descendantsOfType(["use_declaration", "mod_item"])) {
    if (!item) continue;
    if (item.type === "mod_item") {
      const name = item.childForFieldName("name")?.text;
      if (name && !item.childForFieldName("body")) {
        imports.push({ local: name, imported: "*", source: `self::${name}` });
      }
      continue;
    }
    const argument = item.childForFieldName("argument");
    if (argument) collectUse(argument, "", imports);
  }
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(fn|struct|enum|union|trait|type|mod|const|static|macro_rules!)\\s+${word}${WORD_END}`,
    `^\\s*(pub(\\([^)]*\\))?\\s+)?${word}${WORD_END}\\s*(:|,|\\(|\\{|=|$)`,
  );
}

export const RUST: CodeNavigationLanguage = {
  id: "rust",
  family: "rust",
  wasmFile: "tree-sitter-rust.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["source_file", "block", "for_expression", "closure_expression"]),
  functionTypes: new Set([
    "function_item",
    "function_signature_item",
    "closure_expression",
    "impl_item",
    "trait_item",
    "struct_item",
    "enum_item",
    "type_item",
  ]),
  moduleSeparator: "::",
  moduleLinks,
  importCandidates,
  definitionLine,
};
