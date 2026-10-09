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

export const revisionKey = (revision: CodeNavigationRevision) =>
  revision._tag === "workingTree"
    ? "worktree"
    : revision._tag === "checkpoint"
      ? `checkpoint:${revision.threadId}:${revision.turnCount}`
      : `${revision._tag}:${revision.ref}`;

/** The file a side of a diff shows: a deletion or rename names the old path there. */
export function pathForSide(fileDiff: FileDiffMetadata, side: DiffSide) {
  return side === "deletions" ? (fileDiff.prevName ?? fileDiff.name) : fileDiff.name;
}

interface KeyLike {
  readonly key: string;
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

/** VS Code's Go Back: Ctrl+- and Cmd+[ on macOS, Alt+Left elsewhere. */
export function isBackShortcut(event: KeyLike, mac: boolean) {
  if (mac) {
    return (
      (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "[") ||
      (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "-")
    );
  }
  return event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowLeft";
}

/** VS Code's Find All References. */
export const isReferencesShortcut = (event: KeyLike) =>
  event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "F12";

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

function samePlace(left: NavigationPlace, right: NavigationPlace) {
  if (left.kind !== right.kind || left.path !== right.path || left.line !== right.line) {
    return false;
  }
  if (left.kind === "diff" && right.kind === "diff") return left.side === right.side;
  return (
    left.kind === "file" &&
    right.kind === "file" &&
    revisionKey(left.revision) === revisionKey(right.revision)
  );
}
