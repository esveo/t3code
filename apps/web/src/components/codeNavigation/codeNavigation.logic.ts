/**
 * Fork: pure rules of code navigation in the diff viewers — which revision a
 * side of a diff shows, which keys navigate, where a target is visible, and
 * the back stack.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  CodeNavigationLocation,
  CodeNavigationRevision,
  ReviewDiffRange,
  ThreadId,
} from "@t3tools/contracts";

export type DiffSide = "deletions" | "additions";

/** The revisions the two sides of a diff show; null where navigation is unavailable. */
export interface DiffRevisions {
  readonly base: CodeNavigationRevision | null;
  readonly head: CodeNavigationRevision | null;
}

export const WORKING_TREE: CodeNavigationRevision = { _tag: "workingTree" };

/** Deleted lines live in the old revision; added and context lines in the new one. */
export function revisionForSide(revisions: DiffRevisions, side: DiffSide) {
  return side === "deletions" ? revisions.base : revisions.head;
}

/** A commit against its first parent, or the working tree (`head: null`) against a commit. */
export function gitGraphRevisions(range: ReviewDiffRange): DiffRevisions {
  return {
    base: range.base ? { _tag: "git", ref: range.base } : null,
    head: range.head ? { _tag: "git", ref: range.head } : WORKING_TREE,
  };
}

export type DiffPanelSelection =
  | { readonly kind: "unstaged" }
  | { readonly kind: "branch"; readonly baseRef: string | null }
  | { readonly kind: "turn"; readonly threadId: ThreadId; readonly turnCount: number | undefined };

/** The thread diff panel: uncommitted changes, the branch against its base, or one turn. */
export function diffPanelRevisions(selection: DiffPanelSelection): DiffRevisions {
  switch (selection.kind) {
    case "unstaged":
      return { base: { _tag: "git", ref: "HEAD" }, head: WORKING_TREE };
    case "branch":
      // The branch diff runs from the merge base, not the base branch's tip, to the working tree.
      return { base: { _tag: "mergeBase", ref: selection.baseRef ?? "HEAD" }, head: WORKING_TREE };
    case "turn": {
      const turnCount = selection.turnCount;
      if (turnCount === undefined || turnCount < 1) return { base: null, head: null };
      return {
        base: { _tag: "checkpoint", threadId: selection.threadId, turnCount: turnCount - 1 },
        head: { _tag: "checkpoint", threadId: selection.threadId, turnCount },
      };
    }
  }
}

/** What a pull request's Code tab shows: the whole change, or one commit of it. */
export interface PullRequestDiffScope {
  readonly repository: string;
  readonly number: number;
  readonly baseBranch: string;
  readonly headSha: string | undefined;
  readonly commits: ReadonlyArray<{ readonly oid: string; readonly committedDate: string }>;
  /** The commit the scope dropdown picked; null for all commits. */
  readonly commit: string | null;
}

/** A pull request's head against its merge base, or one of its commits against its parent. */
export function pullRequestRevisions(scope: PullRequestDiffScope): DiffRevisions {
  const firstCommit = scope.commits.reduce<(typeof scope.commits)[number] | undefined>(
    (oldest, commit) =>
      oldest === undefined || Date.parse(commit.committedDate) < Date.parse(oldest.committedDate)
        ? commit
        : oldest,
    undefined,
  )?.oid;
  const shared = {
    _tag: "pullRequest" as const,
    repository: scope.repository,
    number: scope.number,
    baseBranch: scope.baseBranch,
    ...(scope.headSha ? { headSha: scope.headSha } : {}),
    ...(scope.commit ? { commit: scope.commit } : firstCommit ? { firstCommit } : {}),
  };
  return { base: { ...shared, side: "base" }, head: { ...shared, side: "head" } };
}

export const revisionKey = (revision: CodeNavigationRevision) => {
  switch (revision._tag) {
    case "workingTree":
      return "worktree";
    case "checkpoint":
      return `checkpoint:${revision.threadId}:${revision.turnCount}`;
    case "pullRequest":
      return `pullRequest:${revision.side}:${revision.repository}#${revision.number}:${revision.commit ?? revision.headSha ?? ""}`;
    default:
      return `${revision._tag}:${revision.ref}`;
  }
};

/** The file a side of a diff shows: a deletion or rename names the old path there. */
export function pathForSide(fileDiff: FileDiffMetadata, side: DiffSide) {
  return side === "deletions" ? (fileDiff.prevName ?? fileDiff.name) : fileDiff.name;
}

interface KeyLike {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Cmd on macOS, Ctrl elsewhere — alone, so Cmd+Ctrl or Ctrl+Click on a Mac stays native. */
export function isNavigationModifier(event: Omit<KeyLike, "key">, mac: boolean) {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The key that is the navigation modifier itself, for keydown and keyup. */
export const isNavigationModifierKey = (key: string, mac: boolean) =>
  mac ? key === "Meta" : key === "Control";

const isMinusKey = (event: KeyLike) =>
  event.code === "Minus" || event.key === "-" || event.key === "_";

/**
 * VS Code's Go Back and Go Forward: Ctrl+- and Ctrl+Shift+- on macOS, where
 * Cmd+[ and Cmd+] also work outside an editor (in one they outdent and
 * indent); Alt+Left and Alt+Right elsewhere.
 */
function isHistoryShortcut(event: KeyLike, mac: boolean, inEditor: boolean, forward: boolean) {
  if (mac) {
    return (
      (!inEditor &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === (forward ? "]" : "[")) ||
      (event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.shiftKey === forward &&
        isMinusKey(event))
    );
  }
  return (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    event.key === (forward ? "ArrowRight" : "ArrowLeft")
  );
}

export const isBackShortcut = (event: KeyLike, mac: boolean, inEditor = false) =>
  isHistoryShortcut(event, mac, inEditor, false);

export const isForwardShortcut = (event: KeyLike, mac: boolean, inEditor = false) =>
  isHistoryShortcut(event, mac, inEditor, true);

/** VS Code's Find All References. */
export const isReferencesShortcut = (event: KeyLike) =>
  event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "F12";

/** VS Code's Go to Definition. */
export const isDefinitionShortcut = (event: KeyLike) =>
  !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "F12";

/** Mouse button 5, the "forward" side button. */
export const isForwardMouseButton = (button: number) => button === 4;

/** Mouse button 4, the "back" side button. */
export const isBackMouseButton = (button: number) => button === 3;

/**
 * Whether a diff shows `line` of a side: hunks cover the changed lines plus
 * their context; everything between them is folded away.
 */
export function isLineInDiff(fileDiff: FileDiffMetadata, side: DiffSide, line: number) {
  return fileDiff.hunks.some((hunk) =>
    side === "deletions"
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
  );
}

/** Which side of a diff shows `revision`, if either. */
export function sideOfRevision(
  revisions: DiffRevisions,
  revision: CodeNavigationRevision,
): DiffSide | null {
  const key = revisionKey(revision);
  if (revisions.head && revisionKey(revisions.head) === key) return "additions";
  if (revisions.base && revisionKey(revisions.base) === key) return "deletions";
  return null;
}

export interface FileReferences {
  readonly path: string;
  readonly locations: ReadonlyArray<CodeNavigationLocation>;
}

/** References grouped by file, files in the order they first appear. */
export function groupByFile(
  locations: ReadonlyArray<CodeNavigationLocation>,
): ReadonlyArray<FileReferences> {
  const groups = new Map<string, CodeNavigationLocation[]>();
  for (const location of locations) {
    const group = groups.get(location.path);
    if (group) group.push(location);
    else groups.set(location.path, [location]);
  }
  return [...groups].map(([path, grouped]) => ({ path, locations: grouped }));
}

/**
 * The character a pointer is over: a caret position falls on the boundary
 * nearest the pointer, which is one past the character when the pointer is
 * over its right half.
 */
export function characterIndexAt(
  caretOffset: number,
  textLength: number,
  pointerIsLeftOfCaretCharacter: boolean,
) {
  const index = pointerIsLeftOfCaretCharacter ? caretOffset - 1 : caretOffset;
  return Math.max(0, Math.min(textLength - 1, index));
}

/** Where navigation was, to come back to. */
export type NavigationPlace =
  | {
      readonly kind: "diff";
      readonly path: string;
      readonly side: DiffSide;
      readonly line: number;
    }
  | {
      readonly kind: "file";
      readonly revision: CodeNavigationRevision;
      readonly path: string;
      readonly line: number;
    }
  | {
      /** The built-in editor, at a repository path of the working tree. */
      readonly kind: "editor";
      readonly path: string;
      readonly line: number;
      readonly column: number;
    };

const HISTORY_LIMIT = 50;

/** VS Code-style back stack: navigating pushes where it left from. */
export function pushPlace(
  history: ReadonlyArray<NavigationPlace>,
  place: NavigationPlace,
): ReadonlyArray<NavigationPlace> {
  const last = history.at(-1);
  if (last && samePlace(last, place)) return history;
  return [...history, place].slice(-HISTORY_LIMIT);
}

export function popPlace(history: ReadonlyArray<NavigationPlace>) {
  return { place: history.at(-1) ?? null, history: history.slice(0, -1) };
}

export interface NavigationHistory {
  readonly back: ReadonlyArray<NavigationPlace>;
  readonly forward: ReadonlyArray<NavigationPlace>;
}

export const EMPTY_HISTORY: NavigationHistory = { back: [], forward: [] };

/** A new navigation from `from`: it can be gone back to, and nothing is ahead anymore. */
export function recordNavigation(history: NavigationHistory, from: NavigationPlace) {
  return { back: pushPlace(history.back, from), forward: [] } satisfies NavigationHistory;
}

/**
 * Goes back or forward: returns the place to open, and the history with
 * `current` (where the user is now) on the other stack to return to.
 */
export function stepHistory(
  history: NavigationHistory,
  direction: "back" | "forward",
  current: NavigationPlace | null,
): { readonly place: NavigationPlace | null; readonly history: NavigationHistory } {
  const from = direction === "back" ? history.back : history.forward;
  const to = direction === "back" ? history.forward : history.back;
  const { place, history: rest } = popPlace(from);
  if (!place) return { place: null, history };
  const other = current ? pushPlace(to, current) : to;
  return {
    place,
    history: direction === "back" ? { back: rest, forward: other } : { back: other, forward: rest },
  };
}

function samePlace(left: NavigationPlace, right: NavigationPlace) {
  if (left.kind !== right.kind || left.path !== right.path || left.line !== right.line) {
    return false;
  }
  if (left.kind === "diff" && right.kind === "diff") return left.side === right.side;
  if (left.kind === "editor") return true;
  return (
    left.kind === "file" &&
    right.kind === "file" &&
    revisionKey(left.revision) === revisionKey(right.revision)
  );
}

const trimSlashes = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * The repository path of a file the editor shows relative to the project's
 * workspace, which may be a folder inside the repository. The way back is
 * `resolveDiffPathForWorkspace`.
 */
export function repositoryPathOf(
  workspacePath: string,
  workspaceRoot: string,
  repositoryRoot: string | undefined,
) {
  if (!repositoryRoot) return workspacePath;
  const root = trimSlashes(repositoryRoot);
  const workspace = trimSlashes(workspaceRoot);
  if (workspace === root || !workspace.startsWith(`${root}/`)) return workspacePath;
  return `${workspace.slice(root.length + 1)}/${workspacePath}`;
}
