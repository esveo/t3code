/**
 * Fork: parses one file with tree-sitter into the plain data code navigation
 * needs (definitions, identifier occurrences, imports), so trees never outlive
 * a parse and the cache holds small objects.
 */
import * as NodeModule from "node:module";
import type * as TreeSitter from "web-tree-sitter";

import type { CodeNavigationLanguage, CodeNavigationLanguageId } from "./languages.ts";

/** A position in a file: 0-based row, column in UTF-16 code units. */
export interface SourcePoint {
  readonly row: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePoint;
  readonly end: SourcePoint;
}

export const MEMBER_KINDS: ReadonlySet<string> = new Set(["method", "field"]);
/** Kinds that name only a type; class, enum and module name both a type and a value. */
const TYPE_ONLY_KINDS: ReadonlySet<string> = new Set(["interface", "type", "typeParameter"]);

/** Whether a definition of `kind` can be what an occurrence in a type (or value) position means. */
export const kindFitsOccurrence = (kind: string, occurrence: { readonly type: boolean }) =>
  occurrence.type
    ? TYPE_ONLY_KINDS.has(kind) || kind === "class" || kind === "enum" || kind === "module"
    : !TYPE_ONLY_KINDS.has(kind);
const LOCAL_KINDS: ReadonlySet<string> = new Set(["parameter", "typeParameter"]);
/** Scopes that hold a class's members. */
const CLASS_SCOPE_TYPES: ReadonlySet<string> = new Set(["class_body", "class_definition"]);

export interface IndexedDefinition {
  readonly name: string;
  readonly kind: string;
  /** The name's position. */
  readonly row: number;
  readonly column: number;
  readonly endColumn: number;
  /** Where the name is visible. */
  readonly scope: SourceRange;
  /** Declared at the top of the file (or as a member of a top-level class). */
  readonly topLevel: boolean;
}

export interface IndexedOccurrence {
  readonly name: string;
  readonly row: number;
  readonly column: number;
  readonly endColumn: number;
  /** `b` in `a.b`. */
  readonly member: boolean;
  /** `a` in `a.b`, when the object is a plain identifier. */
  readonly objectName: string | null;
  /** Names a type (TypeScript's `type_identifier`), not a value. */
  readonly type: boolean;
}

export interface IndexedImport {
  /** The name in this file. */
  readonly local: string;
  /** The name in the imported module: `default`, `*` for a namespace, or the exported name. */
  readonly imported: string;
  readonly source: string;
}

export interface IndexedReExport {
  readonly source: string;
  /** exported name -> name in the source module; null re-exports everything. */
  readonly names: ReadonlyMap<string, string> | null;
}

export interface FileIndex {
  readonly language: CodeNavigationLanguageId;
  readonly lines: ReadonlyArray<string>;
  readonly definitions: ReadonlyArray<IndexedDefinition>;
  readonly occurrences: ReadonlyArray<IndexedOccurrence>;
  readonly imports: ReadonlyArray<IndexedImport>;
  readonly reExports: ReadonlyArray<IndexedReExport>;
  /** The identifier `export default` names, if any. */
  readonly defaultExport: string | null;
}

// web-tree-sitter stays external to the CLI bundle: it loads tree-sitter.wasm
// from beside its own file, and a static import of an external package is a
// hard error inside the single-executable server. `require` reads it from the
// real node_modules in dev and in the packaged server alike.
const requireForTreeSitter = NodeModule.createRequire(import.meta.url);

interface LoadedLanguage {
  readonly parser: TreeSitter.Parser;
  readonly definitions: TreeSitter.Query;
  readonly identifiers: TreeSitter.Query;
}

let runtimePromise: Promise<typeof TreeSitter> | null = null;
const loadedLanguages = new Map<CodeNavigationLanguageId, Promise<LoadedLanguage>>();

function loadRuntime(): Promise<typeof TreeSitter> {
  runtimePromise ??= (async () => {
    const runtime = requireForTreeSitter("web-tree-sitter") as typeof TreeSitter;
    await runtime.Parser.init();
    return runtime;
  })();
  return runtimePromise;
}

function loadLanguage(language: CodeNavigationLanguage): Promise<LoadedLanguage> {
  let loaded = loadedLanguages.get(language.id);
  if (!loaded) {
    loaded = (async () => {
      const runtime = await loadRuntime();
      const wasmPath = requireForTreeSitter.resolve(
        `@vscode/tree-sitter-wasm/wasm/${language.wasmFile}`,
      );
      const grammar = await runtime.Language.load(wasmPath);
      const parser = new runtime.Parser();
      parser.setLanguage(grammar);
      return {
        parser,
        definitions: new runtime.Query(grammar, language.definitionQuery),
        identifiers: new runtime.Query(grammar, language.identifierQuery),
      };
    })();
    // A failed load (missing wasm) is retried on the next request instead of cached.
    loaded.catch(() => loadedLanguages.delete(language.id));
    loadedLanguages.set(language.id, loaded);
  }
  return loaded;
}

const pointOf = (point: TreeSitter.Point): SourcePoint => ({
  row: point.row,
  column: point.column,
});

const rangeOf = (node: TreeSitter.Node): SourceRange => ({
  start: pointOf(node.startPosition),
  end: pointOf(node.endPosition),
});

const positionKey = (row: number, column: number) => `${row}:${column}`;

function enclosing(node: TreeSitter.Node, types: ReadonlySet<string>): TreeSitter.Node | null {
  for (let current = node.parent; current; current = current.parent) {
    if (types.has(current.type)) return current;
  }
  return null;
}

const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, "");

function collectJsModuleLinks(root: TreeSitter.Node): {
  imports: IndexedImport[];
  reExports: IndexedReExport[];
  defaultExport: string | null;
} {
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

function collectPythonImports(root: TreeSitter.Node): IndexedImport[] {
  const imports: IndexedImport[] = [];
  for (const statement of root.descendantsOfType(["import_from_statement", "import_statement"])) {
    if (!statement) continue;
    if (statement.type === "import_from_statement") {
      const source = statement.childForFieldName("module_name")?.text;
      if (!source) continue;
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        if (name.type === "aliased_import") {
          const imported = name.childForFieldName("name")?.text;
          const alias = name.childForFieldName("alias")?.text;
          if (imported && alias) imports.push({ local: alias, imported, source });
        } else {
          imports.push({ local: name.text, imported: name.text, source });
        }
      }
    } else {
      for (const name of statement.childrenForFieldName("name")) {
        if (!name) continue;
        const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
        const alias = name.type === "aliased_import" ? name.childForFieldName("alias")?.text : null;
        if (!dotted) continue;
        imports.push({
          local: alias ?? dotted.text.split(".")[0]!,
          imported: "*",
          source: alias ? dotted.text : dotted.text.split(".")[0]!,
        });
      }
    }
  }
  return imports;
}

/** Parses `source` and extracts its index; null when the parser gives up. */
export async function indexFile(
  language: CodeNavigationLanguage,
  source: string,
): Promise<FileIndex | null> {
  const loaded = await loadLanguage(language);
  const tree = loaded.parser.parse(source);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    const definitionsByPosition = new Map<string, IndexedDefinition>();
    for (const match of loaded.definitions.matches(root)) {
      const nameNode = match.captures.find((capture) => capture.name === "name")?.node;
      const definitionCapture = match.captures.find((capture) =>
        capture.name.startsWith("definition."),
      );
      if (!nameNode || !definitionCapture) continue;
      const kind = definitionCapture.name.slice("definition.".length);
      const key = positionKey(nameNode.startPosition.row, nameNode.startPosition.column);
      const existing = definitionsByPosition.get(key);
      // Python matches a method as a function too; the member kind wins.
      if (existing && !MEMBER_KINDS.has(kind)) continue;
      const scopeNode = LOCAL_KINDS.has(kind)
        ? enclosing(definitionCapture.node, language.functionTypes)
        : enclosing(definitionCapture.node, language.scopeTypes);
      const owner = scopeNode ?? root;
      // A member counts when its class is top-level, also when it is assigned
      // inside a method (Python's `self.x = …`).
      const memberClass = MEMBER_KINDS.has(kind)
        ? owner.type === "class_body" || owner.type === "class_definition"
          ? owner
          : enclosing(owner, CLASS_SCOPE_TYPES)
        : null;
      const topLevel =
        owner.id === root.id ||
        (memberClass !== null && enclosing(memberClass, language.scopeTypes)?.id === root.id);
      definitionsByPosition.set(key, {
        name: nameNode.text,
        kind,
        row: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
        endColumn: nameNode.endPosition.column,
        scope: rangeOf(owner),
        topLevel,
      });
    }

    const occurrencesByPosition = new Map<string, IndexedOccurrence>();
    const memberPositions = new Set<string>();
    for (const capture of loaded.identifiers.captures(root)) {
      const node = capture.node;
      const key = positionKey(node.startPosition.row, node.startPosition.column);
      if (capture.name === "member") {
        memberPositions.add(key);
        continue;
      }
      if (node.startPosition.row !== node.endPosition.row) continue;
      occurrencesByPosition.set(key, {
        name: node.text,
        row: node.startPosition.row,
        column: node.startPosition.column,
        endColumn: node.endPosition.column,
        member: false,
        objectName: null,
        type: node.type === "type_identifier",
      });
    }
    const occurrences = [...occurrencesByPosition.entries()].map(([key, occurrence]) => {
      if (!memberPositions.has(key)) return occurrence;
      const node = root.descendantForPosition({ row: occurrence.row, column: occurrence.column });
      const object = node?.parent?.childForFieldName("object") ?? null;
      return {
        ...occurrence,
        member: true,
        objectName: object?.type === "identifier" ? object.text : null,
      };
    });
    occurrences.sort((left, right) => left.row - right.row || left.column - right.column);

    const links =
      language.family === "python"
        ? { imports: collectPythonImports(root), reExports: [], defaultExport: null }
        : collectJsModuleLinks(root);
    return {
      language: language.id,
      lines: source.split(/\r?\n/),
      definitions: [...definitionsByPosition.values()],
      occurrences,
      ...links,
    };
  } finally {
    tree.delete();
  }
}

export const comparePoints = (left: SourcePoint, right: SourcePoint) =>
  left.row - right.row || left.column - right.column;

export const rangeContains = (range: SourceRange, point: SourcePoint) =>
  comparePoints(range.start, point) <= 0 && comparePoints(point, range.end) <= 0;

export function occurrenceAt(
  index: FileIndex,
  row: number,
  column: number,
): IndexedOccurrence | null {
  return (
    index.occurrences.find(
      (occurrence) =>
        occurrence.row === row && occurrence.column <= column && column < occurrence.endColumn,
    ) ?? null
  );
}

export function definitionAt(index: FileIndex, occurrence: IndexedOccurrence) {
  return (
    index.definitions.find(
      (definition) => definition.row === occurrence.row && definition.column === occurrence.column,
    ) ?? null
  );
}

/**
 * The definitions of `occurrence`'s name visible at its position, innermost
 * scope first; only that scope's definitions are returned. A name declared
 * twice in one scope (Python reassignments) keeps its first declaration.
 */
export function visibleDefinitions(
  index: FileIndex,
  occurrence: IndexedOccurrence,
): ReadonlyArray<IndexedDefinition> {
  const point = { row: occurrence.row, column: occurrence.column };
  const candidates = index.definitions.filter(
    (definition) =>
      definition.name === occurrence.name &&
      definition.kind !== "import" &&
      !MEMBER_KINDS.has(definition.kind) &&
      kindFitsOccurrence(definition.kind, occurrence) &&
      rangeContains(definition.scope, point),
  );
  if (candidates.length === 0) return [];
  const innermost = candidates.reduce((best, candidate) =>
    comparePoints(candidate.scope.start, best.scope.start) > 0 ? candidate : best,
  );
  const sameScope = candidates.filter(
    (candidate) =>
      comparePoints(candidate.scope.start, innermost.scope.start) === 0 &&
      comparePoints(candidate.scope.end, innermost.scope.end) === 0,
  );
  const variables = sameScope.filter((candidate) => candidate.kind === "variable");
  const others = sameScope.filter((candidate) => candidate.kind !== "variable");
  return variables.length > 0 ? [...others, variables[0]!] : others;
}
