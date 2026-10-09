/**
 * Fork: PowerShell for code navigation: functions, variables, classes and
 * their members. Names are matched case-sensitively, unlike PowerShell
 * itself. Dot-sourcing and `Import-Module ./x.psm1` rank that file first.
 */
import type * as TreeSitter from "web-tree-sitter";

import {
  anyOf,
  type CodeNavigationLanguage,
  escapeRegExp,
  fileImport,
  relativeThenRoot,
  WORD_END,
} from "./shared.ts";

/** A plain `$x` on the left of `=`, through the grammar's expression layers. */
const ASSIGNED_VARIABLE = `(left_assignment_expression (logical_expression (bitwise_expression (comparison_expression (additive_expression (multiplicative_expression (format_expression (range_expression (array_literal_expression (unary_expression (variable) @name))))))))))`;

const DEFINITIONS = `
(function_statement (function_name) @name) @definition.function
(class_statement . (simple_name) @name) @definition.class
(enum_statement . (simple_name) @name) @definition.enum
(class_method_definition (simple_name) @name) @definition.method
(class_property_definition (variable) @name) @definition.field
(enum_member (simple_name) @name) @definition.field
(script_parameter (variable) @name) @definition.parameter
(class_method_parameter (variable) @name) @definition.parameter
(foreach_statement (variable) @name) @definition.variable
(assignment_expression ${ASSIGNED_VARIABLE}) @definition.variable
`;

const IDENTIFIERS = `
[(variable) (function_name) (command_name) (simple_name) (type_identifier)] @id
(member_name (simple_name) @member)
`;

/** A dot-sourced or imported path without quotes and a leading `$PSScriptRoot/`. */
function scriptPath(text: string): string | null {
  const path = text
    .replace(/^["']|["']$/g, "")
    .replace(/^\$(PSScriptRoot|\{PSScriptRoot\})[\\/]/i, "./")
    .replaceAll("\\", "/");
  return path.includes("$") ? null : path;
}

function moduleLinks(root: TreeSitter.Node) {
  const imports = root
    .descendantsOfType("command")
    .map((command) => {
      if (!command) return null;
      if (command.namedChildren[0]?.type === "command_invokation_operator") {
        const target = command.childForFieldName("command_name");
        return target?.type === "command_name_expr" ? scriptPath(target.text) : null;
      }
      if (!/^import-module$/i.test(command.childForFieldName("command_name")?.text ?? "")) {
        return null;
      }
      const argument = command
        .childForFieldName("command_elements")
        ?.namedChildren.find((child) => child?.type === "generic_token");
      return argument && /\.psm?1$/i.test(argument.text) ? scriptPath(argument.text) : null;
    })
    .filter((source) => source !== null)
    .map(fileImport);
  return { imports, reExports: [], defaultExport: null };
}

function definitionLine(name: string): RegExp {
  const word = escapeRegExp(name);
  return anyOf(
    `\\b(function|filter|class|enum)\\s+${word}${WORD_END}`,
    `(^|[\\s;(\\]])${word}${WORD_END}\\s*=(?!=)`,
    `\\]\\s*${word}${WORD_END}\\s*(\\(|$)`,
    `^\\s*(static\\s+)?${word}${WORD_END}\\s*\\(`,
    `^\\s*${word}${WORD_END}\\s*(;|=|$)`,
  );
}

export const POWERSHELL: CodeNavigationLanguage = {
  id: "powershell",
  family: "powershell",
  wasmFile: "tree-sitter-powershell.wasm",
  definitionQuery: DEFINITIONS,
  identifierQuery: IDENTIFIERS,
  scopeTypes: new Set(["program", "function_statement", "script_block"]),
  functionTypes: new Set(["function_statement", "class_method_definition", "script_block"]),
  memberSigil: "$",
  moduleLinks,
  importCandidates: relativeThenRoot,
  definitionLine,
};
