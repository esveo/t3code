// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: go to definition and find references for the diff viewers.
 *
 * Search based and stateless, like GitHub's code navigation: the file at the
 * requested revision is parsed with tree-sitter to find the identifier and its
 * scope; definitions elsewhere are found through the file's imports, then by
 * `git grep` over the language's files at the same revision. Parsed files are
 * cached by blob sha (immutable), working-tree files by path and mtime.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CODE_NAVIGATION_WS_METHODS,
  CodeNavigationError,
  type CodeNavigationDefinitionResult,
  type CodeNavigationLocation,
  type CodeNavigationPositionInput,
  type CodeNavigationReadFileInput,
  type CodeNavigationReadFileResult,
  type CodeNavigationReferencesResult,
  type CodeNavigationRevision,
  type CodeNavigationSymbol,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  definitionAt,
  type FileIndex,
  type IndexedDefinition,
  type IndexedOccurrence,
  indexFile,
  kindFitsOccurrence,
  MEMBER_KINDS,
  occurrenceAt,
  rangeContains,
  visibleDefinitions,
} from "./fileIndex.ts";
import {
  type CodeNavigationLanguageFamily,
  definitionLinePattern,
  familyPathspecs,
  isSearchableName,
  languageForPath,
} from "./languages.ts";

/** Files above this size are neither parsed nor searched. */
const MAX_PARSED_FILE_BYTES = 1_000_000;
const MAX_READ_FILE_BYTES = 2_000_000;
/** Files parsed when searching the repository for a definition. */
const MAX_DEFINITION_SEARCH_FILES = 120;
/** Files parsed when collecting references. */
const MAX_REFERENCE_FILES = 300;
const MAX_DEFINITIONS = 50;
const MAX_REFERENCES = 1_000;
const INDEX_CACHE_ENTRIES = 600;
const IMPORT_DEPTH = 4;
const PREVIEW_LENGTH = 240;

export class CodeNavigation extends Context.Service<
  CodeNavigation,
  {
    readonly resolveDefinition: (
      input: CodeNavigationPositionInput,
    ) => Effect.Effect<CodeNavigationDefinitionResult, CodeNavigationError>;
    readonly findReferences: (
      input: CodeNavigationPositionInput,
    ) => Effect.Effect<CodeNavigationReferencesResult, CodeNavigationError>;
    readonly readFile: (
      input: CodeNavigationReadFileInput,
    ) => Effect.Effect<CodeNavigationReadFileResult, CodeNavigationError>;
  }
>()("t3/codeNavigation/CodeNavigation") {}

/** A revision resolved to a commit in a repository; a null commit is the working tree. */
interface RepositoryRevision {
  readonly root: string;
  readonly commit: string | null;
}

interface IndexedFile {
  readonly path: string;
  readonly index: FileIndex;
}

interface GrepFile {
  readonly path: string;
  readonly lines: ReadonlyArray<string>;
}

const EMPTY_DEFINITION: CodeNavigationDefinitionResult = {
  symbol: null,
  isDefinition: false,
  definitions: [],
};

const failure = (message: string) => new CodeNavigationError({ message });

/** Repository paths only: no absolute paths, no way out of the repository. */
function normalizeRepositoryPath(path: string): string | null {
  const normalized = NodePath.posix.normalize(path.replaceAll("\\", "/"));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    NodePath.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

function location(file: IndexedFile, definition: IndexedDefinition): CodeNavigationLocation;
function location(
  file: IndexedFile,
  occurrence: IndexedOccurrence,
  kind: string,
): CodeNavigationLocation;
function location(
  file: IndexedFile,
  target: IndexedDefinition | IndexedOccurrence,
  kind?: string,
): CodeNavigationLocation {
  return {
    path: file.path,
    line: target.row + 1,
    column: target.column,
    endColumn: target.endColumn,
    preview: (file.index.lines[target.row] ?? "").trim().slice(0, PREVIEW_LENGTH),
    kind: kind ?? ("kind" in target ? target.kind : "reference"),
  };
}

function symbolOf(occurrence: IndexedOccurrence): CodeNavigationSymbol {
  return {
    name: occurrence.name,
    line: occurrence.row + 1,
    column: occurrence.column,
    endColumn: occurrence.endColumn,
  };
}

/** Parses `git cat-file --batch` output: `<sha> <type> <size>\n<content>\n` per object. */
function parseCatFileBatch(output: Uint8Array): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) break;
    const [sha, type, size] = decoder.decode(output.subarray(offset, headerEnd)).split(" ");
    offset = headerEnd + 1;
    if (!sha || type === "missing" || size === undefined) continue;
    const length = Number(size);
    objects.set(sha, output.subarray(offset, offset + length));
    offset += length + 1;
  }
  return objects;
}

export const make = Effect.gen(function* () {
  const vcs = yield* VcsProcess.VcsProcess;
  const threads = yield* Effect.serviceOption(ThreadManagementService);
  const indexCache = new LruCache<FileIndex | null>(INDEX_CACHE_ENTRIES);
  const rootByCwd = new Map<string, string>();
  const checkpointCommits = new Map<string, string>();

  const git = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly stdin?: string; readonly allowNonZeroExit?: boolean } = {},
  ) =>
    vcs
      .run({
        operation: `CodeNavigation.${operation}`,
        command: "git",
        cwd,
        args,
        maxOutputBytes: 16_000_000,
        ...options,
      })
      .pipe(Effect.mapError((error) => failure(`git ${args[0]} failed: ${error.message}`)));

  /** Like `git`, but keeps stdout as bytes so blob sizes line up. */
  const gitBytes = (operation: string, cwd: string, args: ReadonlyArray<string>, stdin: string) =>
    Effect.gen(function* () {
      const chunks: Uint8Array[] = [];
      yield* vcs
        .run({
          operation: `CodeNavigation.${operation}`,
          command: "git",
          cwd,
          args,
          stdin,
          maxOutputBytes: 64_000_000,
          onStdoutChunk: (chunk) => chunks.push(chunk),
        })
        .pipe(Effect.mapError((error) => failure(`git ${args[0]} failed: ${error.message}`)));
      return Buffer.concat(chunks);
    });

  const repositoryRoot = Effect.fn("CodeNavigation.repositoryRoot")(function* (cwd: string) {
    const cached = rootByCwd.get(cwd);
    if (cached) return cached;
    const result = yield* git("showToplevel", cwd, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    if (!root) return yield* failure("Not a git repository.");
    rootByCwd.set(cwd, root);
    return root;
  });

  const checkpointRef = Effect.fn("CodeNavigation.checkpointRef")(function* (
    revision: Extract<CodeNavigationRevision, { _tag: "checkpoint" }>,
  ) {
    if (Option.isNone(threads)) return yield* failure("Checkpoints are unavailable.");
    const context = yield* threads.value
      .getCheckpointContext(revision.threadId)
      .pipe(Effect.mapError(() => failure("The thread's checkpoints are unavailable.")));
    if (revision.turnCount === 0) {
      const rootScope = context.checkpointScopes.find((scope) => scope.kind === "root_run");
      if (rootScope) {
        return checkpointRefForScopeOrdinal({ scopeId: rootScope.id, ordinalWithinScope: 0 });
      }
    }
    const checkpoint = context.checkpoints.find(
      (candidate) => candidate.status === "ready" && candidate.appRunOrdinal === revision.turnCount,
    );
    if (!checkpoint) return yield* failure(`No checkpoint for turn ${revision.turnCount}.`);
    return checkpoint.ref;
  });

  const resolveRevision = Effect.fn("CodeNavigation.resolveRevision")(function* (
    cwd: string,
    revision: CodeNavigationRevision,
  ) {
    const root = yield* repositoryRoot(cwd);
    if (revision._tag === "workingTree") return { root, commit: null } satisfies RepositoryRevision;
    if (revision._tag === "git" && /^[0-9a-f]{40}$/.test(revision.ref)) {
      return { root, commit: revision.ref };
    }
    const checkpointKey =
      revision._tag === "checkpoint" ? `${root}:${revision.threadId}:${revision.turnCount}` : null;
    const cachedCheckpoint = checkpointKey ? checkpointCommits.get(checkpointKey) : undefined;
    if (cachedCheckpoint) return { root, commit: cachedCheckpoint };
    const ref = revision._tag === "checkpoint" ? yield* checkpointRef(revision) : revision.ref;
    const result =
      revision._tag === "mergeBase"
        ? yield* git("mergeBase", root, ["merge-base", revision.ref, "HEAD"], {
            allowNonZeroExit: true,
          })
        : yield* git("revParse", root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
            allowNonZeroExit: true,
          });
    const commit = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
      return yield* failure("The revision does not exist in this repository.");
    }
    if (checkpointKey) checkpointCommits.set(checkpointKey, commit);
    return { root, commit };
  });

  const parse = (path: string, source: string) => {
    const language = languageForPath(path);
    if (!language) return Effect.succeed(null);
    return Effect.tryPromise({
      try: () => indexFile(language, source),
      catch: (cause) => failure(`Parsing ${path} failed: ${String(cause)}`),
    });
  };

  /** Indexes of the files among `paths` that exist at the revision, in the order given. */
  const loadIndexes = Effect.fn("CodeNavigation.loadIndexes")(function* (
    revision: RepositoryRevision,
    paths: ReadonlyArray<string>,
  ) {
    const unique = [...new Set(paths)].filter((path) => languageForPath(path) !== null);
    const files: IndexedFile[] = [];
    if (unique.length === 0) return files;

    if (revision.commit === null) {
      for (const path of unique) {
        const absolute = NodePath.join(revision.root, path);
        const stat = yield* Effect.promise(() => NodeFSP.stat(absolute).catch(() => null));
        if (!stat?.isFile() || stat.size > MAX_PARSED_FILE_BYTES) continue;
        const key = `worktree:${absolute}:${stat.mtimeMs}:${stat.size}`;
        let index = indexCache.get(key);
        if (index === undefined) {
          const source = yield* Effect.promise(() =>
            NodeFSP.readFile(absolute, "utf8").catch(() => null),
          );
          index = source === null ? null : yield* parse(path, source);
          indexCache.set(key, index);
        }
        if (index) files.push({ path, index });
      }
      return files;
    }

    const check = yield* git("catFileCheck", revision.root, ["cat-file", "--batch-check"], {
      stdin: unique.map((path) => `${revision.commit}:${path}\n`).join(""),
    });
    const blobs = check.stdout
      .split("\n")
      .slice(0, unique.length)
      .map((line, position) => {
        const [sha, type, size] = line.split(" ");
        return type === "blob" && sha && Number(size) <= MAX_PARSED_FILE_BYTES
          ? { path: unique[position]!, sha }
          : null;
      })
      .filter((blob) => blob !== null);
    const cacheKey = (blob: { path: string; sha: string }) =>
      `${languageForPath(blob.path)!.id}:${blob.sha}`;
    const missing = blobs.filter((blob) => indexCache.get(cacheKey(blob)) === undefined);
    if (missing.length > 0) {
      const contents = parseCatFileBatch(
        yield* gitBytes(
          "catFileBatch",
          revision.root,
          ["cat-file", "--batch"],
          [...new Set(missing.map((blob) => blob.sha))].map((sha) => `${sha}\n`).join(""),
        ),
      );
      const decoder = new TextDecoder();
      for (const blob of missing) {
        const bytes = contents.get(blob.sha);
        indexCache.set(
          cacheKey(blob),
          bytes ? yield* parse(blob.path, decoder.decode(bytes)) : null,
        );
      }
    }
    for (const blob of blobs) {
      const index = indexCache.get(cacheKey(blob));
      if (index) files.push({ path: blob.path, index });
    }
    return files;
  });

  const loadIndex = (revision: RepositoryRevision, path: string) =>
    loadIndexes(revision, [path]).pipe(Effect.map((files) => files[0] ?? null));

  /** Files of the family that contain `name` as a word, with the matching lines. */
  const grep = Effect.fn("CodeNavigation.grep")(function* (
    revision: RepositoryRevision,
    family: CodeNavigationLanguageFamily,
    name: string,
  ) {
    const result = yield* git(
      "grep",
      revision.root,
      [
        "grep",
        "-z",
        "-n",
        "-w",
        "-I",
        "-F",
        "--no-color",
        "-e",
        name,
        ...(revision.commit ? [revision.commit] : ["--untracked"]),
        "--",
        ...familyPathspecs(family),
      ],
      { allowNonZeroExit: true },
    );
    const byPath = new Map<string, string[]>();
    const prefix = revision.commit ? `${revision.commit}:` : "";
    for (const record of result.stdout.split("\n")) {
      const [file, , text] = record.split("\0");
      if (!file || text === undefined) continue;
      const path = file.startsWith(prefix) ? file.slice(prefix.length) : file;
      const lines = byPath.get(path) ?? [];
      lines.push(text);
      byPath.set(path, lines);
    }
    return [...byPath.entries()].map(([path, lines]): GrepFile => ({ path, lines }));
  });

  /**
   * Follows an import to the definitions it names: the module the specifier
   * resolves to, through re-exports. `*` names the module itself.
   */
  const followImport = (
    revision: RepositoryRevision,
    fromPath: string,
    source: string,
    imported: string,
    depth: number,
  ): Effect.Effect<CodeNavigationLocation[], CodeNavigationError> =>
    Effect.gen(function* () {
      const language = languageForPath(fromPath);
      if (!language || depth > IMPORT_DEPTH) return [];
      const file = (yield* loadIndexes(revision, language.importCandidates(fromPath, source)))[0];
      if (!file) {
        // Python's `from . import module` imports a module, not a name.
        if (language.family === "python" && imported !== "*") {
          const moduleSource = source.endsWith(".")
            ? `${source}${imported}`
            : `${source}.${imported}`;
          return yield* followImport(revision, fromPath, moduleSource, "*", depth + 1);
        }
        return [];
      }
      if (imported === "*") {
        return [
          {
            path: file.path,
            line: 1,
            column: 0,
            endColumn: 0,
            preview: (file.index.lines[0] ?? "").trim().slice(0, PREVIEW_LENGTH),
            kind: "module",
          },
        ];
      }
      const name = imported === "default" ? file.index.defaultExport : imported;
      if (name) {
        const definitions = file.index.definitions.filter(
          (definition) =>
            definition.name === name &&
            definition.topLevel &&
            definition.kind !== "import" &&
            !MEMBER_KINDS.has(definition.kind),
        );
        if (definitions.length > 0) {
          return definitions.map((definition) => location(file, definition));
        }
        const reImport = file.index.imports.find((binding) => binding.local === name);
        if (reImport) {
          return yield* followImport(
            revision,
            file.path,
            reImport.source,
            reImport.imported,
            depth + 1,
          );
        }
      }
      for (const reExport of file.index.reExports) {
        const target = reExport.names === null ? imported : reExport.names.get(imported);
        if (target === undefined) continue;
        const found = yield* followImport(revision, file.path, reExport.source, target, depth + 1);
        if (found.length > 0) return found;
      }
      return [];
    });

  /** Paths the file's relative imports may point at. */
  const importedPaths = (file: IndexedFile) => {
    const language = languageForPath(file.path);
    return new Set(
      language
        ? file.index.imports.flatMap((binding) =>
            language.importCandidates(file.path, binding.source),
          )
        : [],
    );
  };

  const rankPaths = (file: IndexedFile, paths: ReadonlyArray<string>) => {
    const imported = importedPaths(file);
    const directory = NodePath.posix.dirname(file.path);
    const area = file.path.split("/").slice(0, 2).join("/");
    const rank = (path: string) =>
      path === file.path
        ? 0
        : imported.has(path)
          ? 1
          : NodePath.posix.dirname(path) === directory
            ? 2
            : path.startsWith(`${area}/`)
              ? 3
              : 4;
    return [...paths].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  };

  /** Definitions of `occurrence`'s name anywhere in the repository. */
  const searchDefinitions = Effect.fn("CodeNavigation.searchDefinitions")(function* (
    revision: RepositoryRevision,
    file: IndexedFile,
    occurrence: IndexedOccurrence,
    name: string,
  ) {
    const language = languageForPath(file.path);
    if (!language || !isSearchableName(name)) return [];
    const pattern = definitionLinePattern(language.family, name);
    const hits = (yield* grep(revision, language.family, name)).filter((hit) =>
      hit.lines.some((line) => pattern.test(line)),
    );
    const paths = rankPaths(
      file,
      hits.map((hit) => hit.path),
    ).slice(0, MAX_DEFINITION_SEARCH_FILES);
    const files = yield* loadIndexes(revision, paths);
    const matches = (member: boolean) =>
      files.flatMap((candidate) =>
        candidate.index.definitions
          .filter(
            (definition) =>
              definition.name === name &&
              definition.topLevel &&
              definition.kind !== "import" &&
              (member
                ? MEMBER_KINDS.has(definition.kind)
                : !MEMBER_KINDS.has(definition.kind) &&
                  kindFitsOccurrence(definition.kind, occurrence)),
          )
          .map((definition) => location(candidate, definition)),
      );
    const found = occurrence.member ? matches(true) : [];
    return (found.length > 0 ? found : matches(false)).slice(0, MAX_DEFINITIONS);
  });

  /** The definitions an occurrence refers to, nearest first. */
  const definitionsOf = Effect.fn("CodeNavigation.definitionsOf")(function* (
    revision: RepositoryRevision,
    file: IndexedFile,
    occurrence: IndexedOccurrence,
  ) {
    const name = occurrence.name;
    if (occurrence.member) {
      const namespace = occurrence.objectName
        ? file.index.imports.find(
            (binding) => binding.local === occurrence.objectName && binding.imported === "*",
          )
        : undefined;
      if (namespace) {
        const found = yield* followImport(revision, file.path, namespace.source, name, 0);
        if (found.length > 0) return found;
      }
      const own = file.index.definitions.filter(
        (definition) => definition.name === name && MEMBER_KINDS.has(definition.kind),
      );
      if (own.length > 0) return own.map((definition) => location(file, definition));
      return yield* searchDefinitions(revision, file, occurrence, name);
    }

    const visible = visibleDefinitions(file.index, occurrence);
    if (visible.length > 0) return visible.map((definition) => location(file, definition));

    const binding = file.index.imports.find((candidate) => candidate.local === name);
    if (binding) {
      const found = yield* followImport(revision, file.path, binding.source, binding.imported, 0);
      if (found.length > 0) return found;
      // A package import: look for the exported name across the repository (workspace packages).
      if (binding.imported === "*" || binding.imported === "default") return [];
      return yield* searchDefinitions(revision, file, occurrence, binding.imported);
    }
    return yield* searchDefinitions(revision, file, occurrence, name);
  });

  const symbolAt = Effect.fn("CodeNavigation.symbolAt")(function* (
    input: CodeNavigationPositionInput,
  ) {
    const path = normalizeRepositoryPath(input.path);
    if (!path || !languageForPath(path)) return null;
    const revision = yield* resolveRevision(input.cwd, input.revision);
    const file = yield* loadIndex(revision, path);
    if (!file) return null;
    const occurrence = occurrenceAt(file.index, input.line - 1, input.column);
    if (!occurrence) return null;
    return { revision, file, occurrence };
  });

  const resolveDefinition: CodeNavigation["Service"]["resolveDefinition"] = Effect.fn(
    "CodeNavigation.resolveDefinition",
  )(function* (input) {
    const target = yield* symbolAt(input);
    if (!target) return EMPTY_DEFINITION;
    const { revision, file, occurrence } = target;
    const own = definitionAt(file.index, occurrence);
    if (own && own.kind !== "import") {
      return {
        symbol: symbolOf(occurrence),
        isDefinition: true,
        definitions: [location(file, own)],
      };
    }
    return {
      symbol: symbolOf(occurrence),
      isDefinition: false,
      definitions: yield* definitionsOf(revision, file, occurrence),
    };
  });

  const findReferences: CodeNavigation["Service"]["findReferences"] = Effect.fn(
    "CodeNavigation.findReferences",
  )(function* (input) {
    const target = yield* symbolAt(input);
    if (!target) return { symbol: null, references: [], truncated: false };
    const { revision, file, occurrence } = target;
    const name = occurrence.name;
    const own = definitionAt(file.index, occurrence);
    const ownDefinition = own && own.kind !== "import" ? own : null;

    // A local (a parameter, a variable inside a function): its uses in its scope.
    const local = ownDefinition
      ? ownDefinition.topLevel || MEMBER_KINDS.has(ownDefinition.kind)
        ? null
        : ownDefinition
      : occurrence.member
        ? null
        : (visibleDefinitions(file.index, occurrence).find((definition) => !definition.topLevel) ??
          null);
    if (local) {
      const references = file.index.occurrences
        .filter(
          (candidate) =>
            candidate.name === name &&
            !candidate.member &&
            rangeContains(local.scope, { row: candidate.row, column: candidate.column }),
        )
        .map((candidate) =>
          location(file, candidate, definitionAt(file.index, candidate)?.kind ?? "reference"),
        );
      return { symbol: symbolOf(occurrence), references, truncated: false };
    }

    const language = languageForPath(file.path);
    if (!language || !isSearchableName(name)) {
      return { symbol: symbolOf(occurrence), references: [], truncated: false };
    }
    const member = ownDefinition ? MEMBER_KINDS.has(ownDefinition.kind) : occurrence.member;
    const hits = yield* grep(revision, language.family, name);
    const paths = rankPaths(
      file,
      hits.map((hit) => hit.path),
    );
    const files = yield* loadIndexes(revision, paths.slice(0, MAX_REFERENCE_FILES));
    const references: CodeNavigationLocation[] = [];
    for (const candidateFile of files) {
      const namespaces = new Set(
        candidateFile.index.imports
          .filter((binding) => binding.imported === "*")
          .map((binding) => binding.local),
      );
      for (const candidate of candidateFile.index.occurrences) {
        if (candidate.name !== name) continue;
        const definition = definitionAt(candidateFile.index, candidate);
        const isMemberName =
          candidate.member || (definition !== null && MEMBER_KINDS.has(definition.kind));
        const viaNamespace = candidate.objectName !== null && namespaces.has(candidate.objectName);
        if (member ? !isMemberName : isMemberName && !viaNamespace) continue;
        // Another file's own local of the same name is not this symbol.
        if (!member && candidateFile.path !== file.path) {
          const shadowing = definition ?? visibleDefinitions(candidateFile.index, candidate)[0];
          if (shadowing && !shadowing.topLevel && shadowing.kind !== "import") continue;
        }
        references.push(location(candidateFile, candidate, definition?.kind ?? "reference"));
      }
    }
    return {
      symbol: symbolOf(occurrence),
      references: references.slice(0, MAX_REFERENCES),
      truncated: paths.length > MAX_REFERENCE_FILES || references.length > MAX_REFERENCES,
    };
  });

  const readFile: CodeNavigation["Service"]["readFile"] = Effect.fn("CodeNavigation.readFile")(
    function* (input) {
      const path = normalizeRepositoryPath(input.path);
      if (!path) return yield* failure("The path is outside the repository.");
      const revision = yield* resolveRevision(input.cwd, input.revision);
      let bytes: Uint8Array;
      if (revision.commit === null) {
        const absolute = NodePath.join(revision.root, path);
        const read = yield* Effect.promise(() => NodeFSP.readFile(absolute).catch(() => null));
        if (!read) return yield* failure(`${path} does not exist in the working tree.`);
        bytes = read;
      } else {
        const objects = parseCatFileBatch(
          yield* gitBytes(
            "readFile",
            revision.root,
            ["cat-file", "--batch"],
            `${revision.commit}:${path}\n`,
          ),
        );
        const blob = objects.values().next().value;
        if (!blob) return yield* failure(`${path} does not exist at this revision.`);
        bytes = blob;
      }
      const truncated = bytes.length > MAX_READ_FILE_BYTES;
      return {
        path,
        contents: new TextDecoder().decode(
          truncated ? bytes.subarray(0, MAX_READ_FILE_BYTES) : bytes,
        ),
        truncated,
      };
    },
  );

  return CodeNavigation.of({ resolveDefinition, findReferences, readFile });
});

export const layer = Layer.effect(CodeNavigation, make);

/**
 * The RPC side reads the service optionally, so server tests that build the
 * websocket layer do not have to provide it.
 */
const withService = <A>(
  use: (service: CodeNavigation["Service"]) => Effect.Effect<A, CodeNavigationError>,
) =>
  Effect.flatMap(Effect.serviceOption(CodeNavigation), (service) =>
    Option.isSome(service)
      ? use(service.value)
      : Effect.fail(failure("This server does not offer code navigation.")),
  );

/** Spread into the websocket RPC handlers. */
export const rpcHandlers = {
  [CODE_NAVIGATION_WS_METHODS.resolveDefinition]: (input: CodeNavigationPositionInput) =>
    observeRpcEffect(
      CODE_NAVIGATION_WS_METHODS.resolveDefinition,
      withService((service) => service.resolveDefinition(input)),
      { "rpc.aggregate": "vcs" },
    ),
  [CODE_NAVIGATION_WS_METHODS.findReferences]: (input: CodeNavigationPositionInput) =>
    observeRpcEffect(
      CODE_NAVIGATION_WS_METHODS.findReferences,
      withService((service) => service.findReferences(input)),
      { "rpc.aggregate": "vcs" },
    ),
  [CODE_NAVIGATION_WS_METHODS.readFile]: (input: CodeNavigationReadFileInput) =>
    observeRpcEffect(
      CODE_NAVIGATION_WS_METHODS.readFile,
      withService((service) => service.readFile(input)),
      { "rpc.aggregate": "vcs" },
    ),
};
