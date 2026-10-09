import type { FileDiffMetadata } from "@pierre/diffs";
import { ThreadId, type CodeNavigationLocation } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  characterIndexAt,
  diffPanelRevisions,
  gitGraphRevisions,
  groupByFile,
  isBackMouseButton,
  isBackShortcut,
  isLineInDiff,
  isNavigationModifier,
  isReferencesShortcut,
  pathForSide,
  popPlace,
  pullRequestRevisions,
  pushPlace,
  revisionForSide,
  sideOfRevision,
  WORKING_TREE,
  type NavigationPlace,
} from "./codeNavigation.logic";

const key = (key: string, modifiers: Partial<Record<"meta" | "ctrl" | "alt" | "shift", true>>) => ({
  key,
  metaKey: modifiers.meta === true,
  ctrlKey: modifiers.ctrl === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
});

const fileDiff = (overrides: Partial<FileDiffMetadata>) =>
  ({ name: "src/a.ts", hunks: [], ...overrides }) as unknown as FileDiffMetadata;

describe("revisions", () => {
  it("resolves a pull request's sides, carrying its oldest commit or the picked one", () => {
    const scope = {
      repository: "acme/app",
      number: 7,
      baseBranch: "main",
      headSha: "h".repeat(40),
      commits: [
        { oid: "c2", committedDate: "2026-10-02T10:00:00+02:00" },
        { oid: "c1", committedDate: "2026-10-02T09:00:00Z" },
      ],
      commit: null,
    };
    const shared = {
      _tag: "pullRequest",
      repository: "acme/app",
      number: 7,
      baseBranch: "main",
      headSha: "h".repeat(40),
    } as const;
    const whole = pullRequestRevisions(scope);
    // 10:00+02:00 is 08:00Z, earlier than c1.
    assert.deepEqual(whole.base, { ...shared, firstCommit: "c2", side: "base" });
    assert.deepEqual(whole.head, { ...shared, firstCommit: "c2", side: "head" });
    const one = pullRequestRevisions({ ...scope, commit: "c1" });
    assert.deepEqual(one.head, { ...shared, commit: "c1", side: "head" });
    assert.strictEqual(sideOfRevision(one, { ...shared, commit: "c1", side: "base" }), "deletions");
    assert.strictEqual(sideOfRevision(one, whole.head!), null);
  });

  it("resolves a commit against its first parent, and the working tree against HEAD", () => {
    const commit = gitGraphRevisions({ base: "abc^", head: "abc" });
    assert.deepEqual(revisionForSide(commit, "deletions"), { _tag: "git", ref: "abc^" });
    assert.deepEqual(revisionForSide(commit, "additions"), { _tag: "git", ref: "abc" });

    const worktree = gitGraphRevisions({ base: "HEAD", head: null });
    assert.deepEqual(revisionForSide(worktree, "additions"), WORKING_TREE);

    const root = gitGraphRevisions({ base: null, head: "abc" });
    assert.isNull(revisionForSide(root, "deletions"));
  });

  it("maps the thread diff's selections to revisions", () => {
    assert.deepEqual(diffPanelRevisions({ kind: "unstaged" }), {
      base: { _tag: "git", ref: "HEAD" },
      head: WORKING_TREE,
    });
    assert.deepEqual(diffPanelRevisions({ kind: "branch", baseRef: "fork" }), {
      base: { _tag: "mergeBase", ref: "fork" },
      head: WORKING_TREE,
    });

    const threadId = ThreadId.make("thread-1");
    assert.deepEqual(diffPanelRevisions({ kind: "turn", threadId, turnCount: 3 }), {
      base: { _tag: "checkpoint", threadId, turnCount: 2 },
      head: { _tag: "checkpoint", threadId, turnCount: 3 },
    });
    assert.deepEqual(diffPanelRevisions({ kind: "turn", threadId, turnCount: undefined }), {
      base: null,
      head: null,
    });
  });

  it("finds the side of a diff that shows a revision", () => {
    const revisions = gitGraphRevisions({ base: "abc^", head: "abc" });
    assert.equal(sideOfRevision(revisions, { _tag: "git", ref: "abc" }), "additions");
    assert.equal(sideOfRevision(revisions, { _tag: "git", ref: "abc^" }), "deletions");
    assert.isNull(sideOfRevision(revisions, WORKING_TREE));
  });

  it("names a renamed file by its old path on the deletions side", () => {
    const renamed = fileDiff({ name: "src/new.ts", prevName: "src/old.ts" });
    assert.equal(pathForSide(renamed, "deletions"), "src/old.ts");
    assert.equal(pathForSide(renamed, "additions"), "src/new.ts");
    assert.equal(pathForSide(fileDiff({}), "deletions"), "src/a.ts");
  });
});

describe("keys", () => {
  it("navigates with Cmd alone on macOS and Ctrl alone elsewhere", () => {
    assert.isTrue(isNavigationModifier(key("", { meta: true }), true));
    assert.isFalse(isNavigationModifier(key("", { ctrl: true }), true));
    assert.isFalse(isNavigationModifier(key("", { meta: true, ctrl: true }), true));
    assert.isTrue(isNavigationModifier(key("", { ctrl: true }), false));
    assert.isFalse(isNavigationModifier(key("", { meta: true }), false));
  });

  it("goes back like VS Code on each platform", () => {
    assert.isTrue(isBackShortcut(key("[", { meta: true }), true));
    assert.isTrue(isBackShortcut(key("-", { ctrl: true }), true));
    assert.isFalse(isBackShortcut(key("[", { meta: true, shift: true }), true));
    assert.isFalse(isBackShortcut(key("ArrowLeft", { alt: true }), true));
    assert.isTrue(isBackShortcut(key("ArrowLeft", { alt: true }), false));
    assert.isFalse(isBackShortcut(key("[", { ctrl: true }), false));
    assert.isTrue(isBackMouseButton(3));
    assert.isFalse(isBackMouseButton(0));
  });

  it("finds references with Shift+F12 only", () => {
    assert.isTrue(isReferencesShortcut(key("F12", { shift: true })));
    assert.isFalse(isReferencesShortcut(key("F12", {})));
    assert.isFalse(isReferencesShortcut(key("F12", { shift: true, meta: true })));
  });
});

describe("positions", () => {
  it("knows which lines the hunks of a diff show on each side", () => {
    const diff = fileDiff({
      hunks: [
        { deletionStart: 10, deletionCount: 4, additionStart: 10, additionCount: 6 },
      ] as unknown as FileDiffMetadata["hunks"],
    });
    assert.isTrue(isLineInDiff(diff, "deletions", 13));
    assert.isFalse(isLineInDiff(diff, "deletions", 14));
    assert.isTrue(isLineInDiff(diff, "additions", 15));
    assert.isFalse(isLineInDiff(diff, "additions", 9));
  });

  it("picks the character under the pointer from a caret boundary", () => {
    // Pointer over the right half of character 2: the caret lands after it.
    assert.equal(characterIndexAt(3, 5, true), 2);
    // Pointer over the left half of character 3: the caret lands before it.
    assert.equal(characterIndexAt(3, 5, false), 3);
    assert.equal(characterIndexAt(0, 5, true), 0);
    assert.equal(characterIndexAt(5, 5, false), 4);
  });

  it("groups references by file in order of appearance", () => {
    const at = (path: string, line: number): CodeNavigationLocation => ({
      path,
      line,
      column: 0,
      endColumn: 1,
      preview: "",
      kind: "reference",
    });
    const groups = groupByFile([at("b.ts", 1), at("a.ts", 2), at("b.ts", 7)]);
    assert.deepEqual(
      groups.map((group) => [group.path, group.locations.map((location) => location.line)]),
      [
        ["b.ts", [1, 7]],
        ["a.ts", [2]],
      ],
    );
  });
});

describe("history", () => {
  const diffPlace = (line: number): NavigationPlace => ({
    kind: "diff",
    path: "src/a.ts",
    side: "additions",
    line,
  });

  it("pushes places, skipping a repeat of the last one, and pops them in reverse", () => {
    let history = pushPlace([], diffPlace(1));
    history = pushPlace(history, diffPlace(1));
    history = pushPlace(history, { kind: "file", revision: WORKING_TREE, path: "b.ts", line: 4 });
    assert.equal(history.length, 2);

    const first = popPlace(history);
    assert.equal(first.place?.kind, "file");
    const second = popPlace(first.history);
    assert.deepEqual(second.place, diffPlace(1));
    assert.isNull(popPlace(second.history).place);
  });

  it("keeps the newest 50 places", () => {
    let history: ReadonlyArray<NavigationPlace> = [];
    for (let line = 1; line <= 60; line++) history = pushPlace(history, diffPlace(line));
    assert.equal(history.length, 50);
    assert.deepEqual(history[0], diffPlace(11));
  });
});
