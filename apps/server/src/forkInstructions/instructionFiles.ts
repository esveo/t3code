// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fork: which instruction file the Instructions tab opens, and reading and
 * writing it with a version check.
 *
 * What the providers read (Claude Code: code.claude.com/docs/en/memory; Codex:
 * openai/codex `core/src/agents_md.rs` and `codex-home/src/instructions`):
 * - Claude, project: `CLAUDE.md` and `.claude/CLAUDE.md` (both load), plus
 *   `CLAUDE.local.md`; `AGENTS.md` only while neither CLAUDE.md exists (the
 *   default of its "Project instructions" setting); global: `<config dir>/CLAUDE.md`. `@path` lines import
 *   other files, relative to the importing file, `~/` from the home directory.
 * - Codex, project: per folder from the repository root down, the first of
 *   `AGENTS.override.md` and `AGENTS.md`; global: the first non-empty one of
 *   the same two names in `CODEX_HOME`. Codex has no imports.
 * The tab edits one file per provider and scope, the one that wins; others
 * that load too only show up as hints. A file that only imports Markdown
 * files opens its first import, with a switcher between them.
 */
import {
  FORK_INSTRUCTIONS_MAX_BYTES,
  type ForkInstructionsChoice,
  ForkInstructionsConflictError,
  ForkInstructionsError,
  type ForkInstructionsProvider,
  type ForkInstructionsScope,
  type ForkInstructionsSnapshot,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Where one provider's files live for this thread. */
export interface InstructionRoots {
  readonly home: string;
  /** The thread's checkout: its worktree, else the project root. */
  readonly checkout: string;
  readonly claudeConfigDir: string;
  readonly codexHome: string;
}

export interface InstructionLocation {
  readonly provider: ForkInstructionsProvider;
  readonly entry: string;
  readonly alsoRead: ReadonlyArray<string>;
}

const failure = (message: string) => new ForkInstructionsError({ message });

export const abbreviateHome = (path: string, home: string) =>
  path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

export const contentVersion = (content: string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

/**
 * The `@path` targets of a file that holds nothing but import lines, such as
 * `@AGENTS.md` followed by `@FORK.md`; null for a file with any other text.
 */
export const importOnlyTargets = (content: string): ReadonlyArray<string> | null => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  // Only Markdown imports count, so an import line cannot open just any file for editing.
  const targets = lines.map((line) => /^@(\S+\.md)$/i.exec(line)?.[1]);
  return targets.every((target) => target !== undefined) ? (targets as string[]) : null;
};

const exists = Effect.fn("forkInstructions.exists")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false));
});

const readExisting = Effect.fn("forkInstructions.readExisting")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* exists(path))) return null;
  const content = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => failure(`Could not read ${path}.`)));
  if (content.length > FORK_INSTRUCTIONS_MAX_BYTES) {
    return yield* failure(`${path} is too large to edit here.`);
  }
  return content;
});

/** The file the provider gives precedence to, and the others it reads beside it. */
export const resolveLocation = Effect.fn("forkInstructions.resolveLocation")(function* (
  provider: ForkInstructionsProvider,
  scope: ForkInstructionsScope,
  roots: InstructionRoots,
) {
  const path = yield* Path.Path;
  const show = (file: string) => abbreviateHome(file, roots.home);
  if (provider === "claude") {
    if (scope === "global") {
      return { provider, entry: path.join(roots.claudeConfigDir, "CLAUDE.md"), alsoRead: [] };
    }
    const root = path.join(roots.checkout, "CLAUDE.md");
    const dotClaude = path.join(roots.checkout, ".claude", "CLAUDE.md");
    const local = path.join(roots.checkout, "CLAUDE.local.md");
    const agents = path.join(roots.checkout, "AGENTS.md");
    const hasRoot = yield* exists(root);
    const hasDotClaude = yield* exists(dotClaude);
    // Without a CLAUDE.md, Claude Code (2.1.277+, by default) reads AGENTS.md instead; a
    // new CLAUDE.md would silently replace it, so the tab edits AGENTS.md then.
    if (!hasRoot && !hasDotClaude && (yield* exists(agents))) {
      return {
        provider,
        entry: agents,
        alsoRead: ["Claude reads AGENTS.md because the project has no CLAUDE.md."],
      } satisfies InstructionLocation;
    }
    const entry = hasRoot || !hasDotClaude ? root : dotClaude;
    const alsoRead: string[] = [];
    for (const other of [root, dotClaude, local]) {
      if (other !== entry && (yield* exists(other))) alsoRead.push(`${show(other)} loads too.`);
    }
    return { provider, entry, alsoRead } satisfies InstructionLocation;
  }
  const folder = scope === "global" ? roots.codexHome : roots.checkout;
  const override = path.join(folder, "AGENTS.override.md");
  const plain = path.join(folder, "AGENTS.md");
  const overrideContent = yield* readExisting(override);
  // Codex passes over an empty home override; in a project any override wins.
  const overrides =
    overrideContent !== null && (scope === "project" || overrideContent.trim().length > 0);
  if (!overrides) return { provider, entry: plain, alsoRead: [] } satisfies InstructionLocation;
  const alsoRead = (yield* exists(plain))
    ? [`${show(plain)} is ignored while ${show(override)} exists.`]
    : [];
  return { provider, entry: override, alsoRead } satisfies InstructionLocation;
});

const resolveImport = (target: string, from: string, home: string, path: Path.Path) =>
  target.startsWith("~/")
    ? path.join(home, target.slice(2))
    : path.resolve(path.dirname(from), target);

/**
 * Reads the snapshot for `file`, which must be the entry or one of its
 * imports; left out, the first import of an import-only entry opens.
 */
export const readSnapshot = Effect.fn("forkInstructions.readSnapshot")(function* (
  location: InstructionLocation,
  home: string,
  file: string | undefined,
) {
  const path = yield* Path.Path;
  const entryContent = yield* readExisting(location.entry);
  const targets =
    location.provider === "claude" && entryContent !== null
      ? importOnlyTargets(entryContent)
      : null;
  const choices: ForkInstructionsChoice[] = [];
  if (targets !== null) {
    const seen = new Set<string>();
    for (const target of targets) {
      const imported = resolveImport(target, location.entry, home, path);
      if (seen.has(imported) || imported === location.entry) continue;
      seen.add(imported);
      choices.push({
        path: imported,
        displayPath: abbreviateHome(imported, home),
        kind: "import",
        exists: yield* exists(imported),
      });
    }
    choices.push({
      path: location.entry,
      displayPath: abbreviateHome(location.entry, home),
      kind: "entry",
      exists: true,
    });
  }
  const open = file ?? choices[0]?.path ?? location.entry;
  if (open !== location.entry && !choices.some((choice) => choice.path === open)) {
    return yield* failure("That file is not one this instruction file imports.");
  }
  const content = open === location.entry ? entryContent : yield* readExisting(open);
  return {
    provider: location.provider,
    path: open,
    displayPath: abbreviateHome(open, home),
    exists: content !== null,
    content: content ?? "",
    version: content === null ? null : contentVersion(content),
    choices,
    alsoRead: location.alsoRead,
  } satisfies ForkInstructionsSnapshot;
});

/**
 * Writes `content` to `file` (validated like a read) unless the file changed
 * since `expectedVersion`, then returns the fresh snapshot. The caller
 * serializes writes; an agent writing at the same moment can still win the race.
 */
export const writeFile = Effect.fn("forkInstructions.writeFile")(function* (
  location: InstructionLocation,
  home: string,
  input: {
    readonly file: string;
    readonly content: string;
    readonly expectedVersion: string | null;
    readonly force?: boolean | undefined;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* readSnapshot(location, home, input.file);
  if (input.force !== true && current.version !== input.expectedVersion) {
    return yield* new ForkInstructionsConflictError({
      message: current.exists
        ? `${current.displayPath} changed since it was opened.`
        : `${current.displayPath} was deleted since it was opened.`,
    });
  }
  yield* fs.makeDirectory(path.dirname(input.file), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(input.file, input.content)),
    Effect.mapError(() => failure(`Could not save ${current.displayPath}.`)),
  );
  return yield* readSnapshot(location, home, input.file);
});
