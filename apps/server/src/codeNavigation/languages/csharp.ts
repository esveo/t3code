/**
 * Fork: C# for code navigation. `using` names namespaces, which do not map to
 * files, so every name outside the file is found by the repository search.
 */
import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  NO_MODULE_LINKS,
  noImportCandidates,
  WORD_END,
  WORD_START,
} from "./shared.ts";

const DEFINITIONS = `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(struct_declaration name: (identifier) @name) @definition.struct
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(delegate_declaration name: (identifier) @name) @definition.type
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function
(property_declaration name: (identifier) @name) @definition.field
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @definition.field
(event_field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @definition.field
(event_declaration name: (identifier) @name) @definition.field
(enum_member_declaration name: (identifier) @name) @definition.field
(local_declaration_statement (variable_declaration (variable_declarator name: (identifier) @name))) @definition.variable
(foreach_statement left: (identifier) @name) @definition.variable
(catch_declaration name: (identifier) @name) @definition.variable
(parameter name: (identifier) @name) @definition.parameter
(lambda_expression parameters: (implicit_parameter) @name) @definition.parameter
(type_parameter name: (identifier) @name) @definition.typeParameter
`;

const IDENTIFIERS = `
(identifier) @id
(member_access_expression name: (identifier) @member)
(member_binding_expression name: (identifier) @member)
`;

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(class|struct|interface|enum|record|delegate|event)\\b[^;{=]*${WORD_START}${word}${WORD_END}`,
    `[\\p{L}\\p{N}_>\\]?]\\s+${WORD_START}${word}${WORD_END}\\s*([(=;,{<]|=>|$)`,
    `^\\s*${word}${WORD_END}\\s*(=|,|$)`,
  );
}

export const CSHARP: CodeNavigationLanguage = {
  id: "csharp",
  family: "csharp",
  wasmFile: "tree-sitter-c-sharp.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set([
    "compilation_unit",
    "block",
    "for_statement",
    "foreach_statement",
    "catch_clause",
    "using_statement",
    "lambda_expression",
    "switch_section",
  ]),
  functionTypes: new Set([
    "method_declaration",
    "constructor_declaration",
    "local_function_statement",
    "lambda_expression",
    "anonymous_method_expression",
    "delegate_declaration",
    "record_declaration",
    "class_declaration",
    "struct_declaration",
    "interface_declaration",
  ]),
  implicitMembers: true,
  moduleLinks: () => NO_MODULE_LINKS,
  importCandidates: noImportCandidates,
  definitionLine,
};
