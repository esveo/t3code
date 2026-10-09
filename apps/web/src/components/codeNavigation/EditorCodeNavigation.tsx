/**
 * Fork: code navigation in the built-in file editor. `EditorCodeNavigation`
 * wraps the editor surface and navigates the working tree: an unsaved buffer
 * is sent along so positions match what the user sees, and targets open in
 * editor tabs with the caret on them. The editor surface binds its Pierre
 * editor with `useEditorCodeNavigation` and spreads the returned options into
 * its file options.
 */
import type { Editor } from "@pierre/diffs/editor";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProject, useThreadShell } from "~/state/entities";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "../files/fileSurfaceChrome";
import { type DiffRevisions, repositoryPathOf, WORKING_TREE } from "./codeNavigation.logic";
import { CODE_NAVIGATION_UNSAFE_CSS, flashLine } from "./codeNavigationDom";
import { type CodeNavigationEditor, useCodeNavigation } from "./useCodeNavigation";

/** What navigation uses of a Pierre editor, whatever its annotations. */
type AnyEditor = Pick<Editor<unknown>, "getState" | "setSelections" | "focus">;

interface Caret {
  readonly line: number;
  readonly column: number;
}

interface Binding {
  readonly options: ReturnType<typeof useCodeNavigation>["options"] & {
    readonly unsafeCSS: string;
  };
  readonly attach: (editor: AnyEditor, relativePath: string) => () => void;
}

const BindingContext = createContext<Binding | null>(null);

const EDITOR_REVISIONS: DiffRevisions = { base: null, head: WORKING_TREE };
const NO_FILES: [] = [];
const ATTACH_FRAMES = 60;

/** The caret a navigation put into a file whose tab is still opening. */
let pendingCaret: { readonly key: string; readonly caret: Caret } | null = null;

const caretKey = (cwd: string, relativePath: string) => `${cwd}\u0000${relativePath}`;

function caretOf(editor: AnyEditor | null): Caret | null {
  const selection = editor?.getState().selections?.at(-1);
  if (!selection) return null;
  // Pierre's selections carry a numeric direction: -1 when the caret is at the start.
  const position = (selection.direction as unknown) === -1 ? selection.start : selection.end;
  return { line: position.line + 1, column: position.character };
}

/**
 * Opens a working-tree file (repository path) in an editor tab of the thread's
 * right panel with the caret on `line`; false when it lies outside the
 * thread's checkout.
 */
export function openInEditorTab(target: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly repositoryRoot: string | undefined;
  readonly path: string;
  readonly line: number;
  readonly column: number;
}) {
  const workspacePath = resolveDiffPathForWorkspace({
    filePath: target.path,
    workspaceRoot: target.cwd,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspacePath === null) return null;
  pendingCaret = {
    key: caretKey(target.cwd, workspacePath),
    caret: { line: target.line, column: target.column },
  };
  useRightPanelStore.getState().openFile(target.threadRef, workspacePath);
  return workspacePath;
}

/** Puts the caret on a line (Pierre scrolls it into view) and flashes the line. */
function placeCaret(editor: AnyEditor, caret: Caret, container: HTMLElement | null) {
  const position = { line: caret.line - 1, character: caret.column };
  editor.setSelections([{ start: position, end: position, direction: "none" }]);
  editor.focus({ preventScroll: true });
  if (container) flashLine(container, null, null, caret.line);
}

export function EditorCodeNavigation({
  environmentId,
  cwd,
  threadRef,
  relativePath,
  contents,
  dirty,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  /** The edited file, relative to `cwd`. */
  readonly relativePath: string;
  /** The editor's buffer. */
  readonly contents: string;
  /** The buffer has edits not saved yet. */
  readonly dirty: boolean;
  readonly children: ReactNode;
}) {
  // Workspace paths are relative to the thread's checkout, which may be a folder of the repository.
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const repositoryRoot = thread?.worktreePath ? undefined : project?.repositoryIdentity?.rootPath;

  const [container, setContainer] = useState<HTMLElement | null>(null);
  const editorRef = useRef<AnyEditor | null>(null);

  const editor = useMemo<CodeNavigationEditor>(
    () => ({
      path: repositoryPathOf(relativePath, cwd, repositoryRoot),
      text: contents,
      dirty,
      caret: () => caretOf(editorRef.current),
    }),
    [contents, cwd, dirty, relativePath, repositoryRoot],
  );

  const openInEditor = useCallback(
    (path: string, line: number, column: number) => {
      const current = editorRef.current;
      if (current && path === repositoryPathOf(relativePath, cwd, repositoryRoot)) {
        placeCaret(current, { line, column }, container);
        return true;
      }
      return openInEditorTab({ threadRef, cwd, repositoryRoot, path, line, column }) !== null;
    },
    [container, cwd, relativePath, repositoryRoot, threadRef],
  );

  const navigation = useCodeNavigation({
    environmentId,
    cwd,
    revisions: EDITOR_REVISIONS,
    files: NO_FILES,
    codeView: null,
    editor,
    openInEditor,
    historyKey: `${threadRef.environmentId}:${threadRef.threadId}:${cwd}`,
  });
  const { mount, options, overlay } = navigation;

  const attach = useCallback(
    (attached: AnyEditor, path: string) => {
      editorRef.current = attached;
      const key = caretKey(cwd, path);
      let frame = 0;
      let attempts = 0;
      // The editor attaches to its file once it has rendered; until then it has no document.
      const apply = () => {
        if (pendingCaret?.key !== key) return;
        try {
          placeCaret(attached, pendingCaret.caret, container);
          pendingCaret = null;
        } catch {
          if (++attempts < ATTACH_FRAMES) frame = requestAnimationFrame(apply);
        }
      };
      frame = requestAnimationFrame(apply);
      return () => {
        cancelAnimationFrame(frame);
        if (editorRef.current === attached) editorRef.current = null;
      };
    },
    [container, cwd],
  );

  const binding = useMemo<Binding>(
    () => ({
      options: { ...options, unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS + CODE_NAVIGATION_UNSAFE_CSS },
      attach,
    }),
    [attach, options],
  );

  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      setContainer(element);
      mount(element);
    },
    [mount],
  );

  return (
    <BindingContext.Provider value={binding}>
      <div ref={setRef} className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {overlay}
      </div>
    </BindingContext.Provider>
  );
}

/** Binds an editor surface inside `EditorCodeNavigation`; spread the result into its file options. */
export function useEditorCodeNavigation(editor: AnyEditor, relativePath: string) {
  const binding = useContext(BindingContext);
  useEffect(() => binding?.attach(editor, relativePath), [binding, editor, relativePath]);
  return binding?.options;
}
