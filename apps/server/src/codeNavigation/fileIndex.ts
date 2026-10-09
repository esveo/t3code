/**
 * Fork: parses one file with tree-sitter into the plain data code navigation
 * needs (definitions, identifier occurrences, imports), so trees never outlive
 * a parse and the cache holds small objects.
 */
import * as NodeModule from "node:module";
import type * as TreeSitter from "web-tree-sitter";

import type { CodeNavigationLanguage } from "./languages.ts";

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
export const kindFitsOccurrence = (kind: string, occurrence: { readonly type: boolean | null }) =>
  occurrence.type === null
    ? true
    : occurrence.type
      ? TYPE_ONLY_KINDS.has(kind) || kind === "class" || kind === "enum" || kind === "module"
      : !TYPE_ONLY_KINDS.has(kind);
/** Kinds scoped to their function (Bash's `local`), not to the nearest block. */
const LOCAL_KINDS: ReadonlySet<string> = new Set(["parameter", "typeParameter", "local"]);
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
  /** Names a type (TypeScript's `type_identifier`), not a value; null when the language does not tell. */
  readonly type: boolean | null;
}

export interface IndexedImport {
  /** The name in this file; empty for an import of a whole file (`#include`), which only ranks searches. */
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
  readonly language: string;
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
const loadedLanguages = new Map<string, Promise<LoadedLanguage>>();

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

/** Fields that hold the object of a member access, across grammars (`a` in `a.b`, `a::b`, `a->b`). */
const OBJECT_FIELDS = [
  "object",
  "operand",
  "value",
  "argument",
  "path",
  "scope",
  "receiver",
  "expression",
  "package",
];

/** `a` in `a.b`, when the object is a plain identifier. */
function memberObjectName(root: TreeSitter.Node, occurrence: IndexedOccurrence): string | null {
  const node = root.descendantForPosition({ row: occurrence.row, column: occurrence.column });
  const access = node?.parent;
  if (!node || !access) return null;
  for (const field of OBJECT_FIELDS) {
    const object = access.childForFieldName(field);
    if (!object || object.id === node.id) continue;
    return object.type === "identifier" || object.type === "package_identifier"
      ? object.text
      : null;
  }
  return null;
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
    const patternByPosition = new Map<string, number>();
    for (const match of loaded.definitions.matches(root)) {
      const nameNode = match.captures.find((capture) => capture.name === "name")?.node;
      const definitionCapture = match.captures.find((capture) =>
        capture.name.startsWith("definition."),
      );
      if (!nameNode || !definitionCapture) continue;
      const kind = definitionCapture.name.slice("definition.".length);
      const key = positionKey(nameNode.startPosition.row, nameNode.startPosition.column);
      const existing = definitionsByPosition.get(key);
      // A method also matches as a function: the member kind wins, otherwise
      // the earlier pattern (Bash's `local x=` over `x=`).
      if (
        existing &&
        (MEMBER_KINDS.has(existing.kind) !== MEMBER_KINDS.has(kind)
          ? !MEMBER_KINDS.has(kind)
          : patternByPosition.get(key)! <= match.patternIndex)
      ) {
        continue;
      }
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
      const sigil = MEMBER_KINDS.has(kind) ? language.memberSigil : undefined;
      definitionsByPosition.set(key, {
        name:
          sigil && nameNode.text.startsWith(sigil)
            ? nameNode.text.slice(sigil.length)
            : nameNode.text,
        kind,
        row: nameNode.startPosition.row,
        column: nameNode.startPosition.column,
        endColumn: nameNode.endPosition.column,
        scope: rangeOf(owner),
        topLevel,
      });
      patternByPosition.set(key, match.patternIndex);
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
      if (capture.name !== "id") continue;
      if (node.startPosition.row !== node.endPosition.row) continue;
      occurrencesByPosition.set(key, {
        name: node.text,
        row: node.startPosition.row,
        column: node.startPosition.column,
        endColumn: node.endPosition.column,
        member: false,
        objectName: null,
        type: language.typeIdentifierTypes ? language.typeIdentifierTypes.has(node.type) : null,
      });
    }
    const occurrences = [...occurrencesByPosition.entries()].map(([key, occurrence]) => {
      // The name an import binds is not a member, even inside a path (Rust's `use a::b`).
      if (!memberPositions.has(key) || definitionsByPosition.get(key)?.kind === "import") {
        return occurrence;
      }
      return { ...occurrence, member: true, objectName: memberObjectName(root, occurrence) };
    });
    occurrences.sort((left, right) => left.row - right.row || left.column - right.column);

    return {
      language: language.id,
      lines: source.split(/\r?\n/),
      definitions: [...definitionsByPosition.values()],
      occurrences,
      ...language.moduleLinks(root),
    };
  } finally {
    tree.delete();
  }
}

export const comparePoints = (left: SourcePoint, right: SourcePoint) =>
  left.row - right.row || left.column - right.column;

export const rangeContains = (range: SourceRange, point: SourcePoint) =>
  comparePoints(range.start, point) <= 0 && comparePoints(point, range.end) <= 0;

/** The identifier at a position; the innermost one where identifiers nest. */
export function occurrenceAt(
  index: FileIndex,
  row: number,
  column: number,
): IndexedOccurrence | null {
  return (
    index.occurrences.findLast(
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
