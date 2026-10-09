/**
 * Fork: VS Code-style code navigation for a diff viewer or the built-in
 * editor. Cmd/Ctrl+hover underlines what has a definition, Cmd/Ctrl+click or
 * F12 goes there (a picker when there are several, references when the word
 * is the definition), Shift+F12 and the context menu find references, and
 * Cmd+[ / Ctrl+- / Alt+Left / mouse back return (forward likewise). Targets
 * inside the diff scroll into view; working-tree targets of the editor open in
 * the editor; others open a read-only file view at the same revision.
 *
 * A surface mounts it with: `mount` as the ref of the element around the viewer
 * (positioned, it hosts the overlay), `options` spread into the viewer's
 * options, and `overlay` rendered inside the container. The underline's CSS
 * ships with every diff viewer (`StyledDiffCodeView`); the editor adds it itself.
 */
import type { CodeViewScrollTarget, FileDiffMetadata, TokenEventBase } from "@pierre/diffs";
import type {
  CodeNavigationDefinitionResult,
  CodeNavigationLocation,
  CodeNavigationPositionInput,
  CodeNavigationRevision,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { readLocalApi } from "~/localApi";
import { isMacPlatform } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  type DiffRevisions,
  type DiffSide,
  EMPTY_HISTORY,
  isBackMouseButton,
  isBackShortcut,
  isDefinitionShortcut,
  isForwardMouseButton,
  isForwardShortcut,
  isLineInDiff,
  isNavigationModifier,
  isNavigationModifierKey,
  isReferencesShortcut,
  type NavigationHistory,
  type NavigationPlace,
  pathForSide,
  recordNavigation,
  revisionForSide,
  revisionKey,
  sideOfRevision,
  stepHistory,
  WORKING_TREE,
} from "./codeNavigation.logic";
import { clearLink, columnAtPoint, flashLine, lineElementOf, showLink } from "./codeNavigationDom";
import {
  CodeNavigationBackButton,
  CodeNavigationFileView,
  CodeNavigationPicker,
  CodeNavigationReferences,
  type FileViewTarget,
  type ReferencesState,
} from "./CodeNavigationOverlay";
import { codeNavigationEnvironment } from "./codeNavigationState";

const HOVER_DEBOUNCE_MS = 50;
const CACHE_LIMIT = 500;

/** A diff's file as the surface knows it; `id` or `fileKey` is its viewer item id. */
export interface CodeNavigationFile {
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed?: boolean;
  readonly id?: string;
  readonly fileKey?: string;
}

/** The built-in editor's file, navigated in the working tree. */
export interface CodeNavigationEditor {
  /** Its repository path; null when it is outside the repository. */
  readonly path: string | null;
  /** The buffer, sent along while it is not saved yet so positions match what the user sees. */
  readonly text: string;
  readonly dirty: boolean;
  /** The primary caret, 1-based line and 0-based column; null without one. */
  readonly caret: () => { readonly line: number; readonly column: number } | null;
}

export interface CodeNavigationSurface {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly revisions: DiffRevisions;
  readonly files: ReadonlyArray<CodeNavigationFile>;
  readonly codeView: { scrollTo(target: CodeViewScrollTarget): void } | null;
  readonly editor?: CodeNavigationEditor | undefined;
  /**
   * Opens a working-tree file (repository path) in the built-in editor; false
   * when it cannot. The editor goes there directly, other surfaces offer it in
   * the read-only file view.
   */
  readonly openInEditor?: ((path: string, line: number, column: number) => boolean) | undefined;
  /** Keeps back and forward across remounts of surfaces sharing it, such as editor tabs. */
  readonly historyKey?: string | undefined;
}

/** The trailing context Pierre's CodeView passes to item callbacks. */
export interface TokenContext {
  readonly item:
    | { readonly type: "diff"; readonly fileDiff: FileDiffMetadata }
    | { readonly type: "file"; readonly file: { readonly name: string } };
}
export type TokenProps = TokenEventBase & { readonly side?: DiffSide };

/** What a navigation starts from: a hovered token or the editor's caret. */
interface Origin {
  readonly revision: CodeNavigationRevision;
  readonly path: string;
  readonly place: NavigationPlace;
}

interface Hover extends Origin {
  readonly token: HTMLElement;
  readonly lineCharStart: number;
  readonly line: number;
}

type Position = Omit<CodeNavigationPositionInput, "cwd">;

type Picker = {
  readonly x: number;
  readonly y: number;
  readonly revision: CodeNavigationRevision;
  readonly locations: ReadonlyArray<CodeNavigationLocation>;
  readonly from: NavigationPlace;
};

/** The hovered position, at the character under the pointer. */
const positionOf = (hover: Hover, x: number, y: number): Position => ({
  revision: hover.revision,
  path: hover.path,
  line: hover.line,
  column: columnAtPoint(hover.token, hover.lineCharStart, x, y),
});

/** An editor place is where the caret or click was, to the column. */
const placeAt = (origin: Origin, position: Position): NavigationPlace =>
  origin.place.kind === "editor"
    ? { ...origin.place, line: position.line, column: position.column }
    : origin.place;

const MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

const histories = new Map<string, NavigationHistory>();

/** Pointer events Alt+click turned into the editor's add-cursor click. */
const remappedEvents = new WeakSet<Event>();

/** A click on the code of a line, not its gutter or a comment below it. */
function isCodeTarget(event: Event) {
  const target = event.composedPath()[0];
  return (
    target instanceof Element &&
    target.closest("[data-line]") !== null &&
    target.closest("[data-gutter], [data-line-annotation]") === null
  );
}

export function useCodeNavigation(surface: CodeNavigationSurface) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fileView, setFileView] = useState<FileViewTarget | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [references, setReferences] = useState<ReferencesState | null>(null);
  const historyKey = surface.historyKey;
  const [history, setHistoryState] = useState<NavigationHistory>(
    () => (historyKey ? histories.get(historyKey) : undefined) ?? EMPTY_HISTORY,
  );
  // Event handlers read the latest values without re-subscribing.
  const surfaceRef = useRef(surface);
  const fileViewRef = useRef(fileView);
  const historyRef = useRef(history);
  useLayoutEffect(() => {
    surfaceRef.current = surface;
    fileViewRef.current = fileView;
    historyRef.current = history;
  });
  const setHistory = useCallback(
    (next: NavigationHistory) => {
      historyRef.current = next;
      if (historyKey) histories.set(historyKey, next);
      setHistoryState(next);
    },
    [historyKey],
  );

  const resolveDefinitionCommand = useAtomCommand(codeNavigationEnvironment.resolveDefinition, {
    reportFailure: false,
  });
  const findReferencesCommand = useAtomCommand(codeNavigationEnvironment.findReferences, {
    reportFailure: false,
  });

  const hoverRef = useRef<Hover | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, inside: false });
  const modifierRef = useRef(false);
  const lookupTimerRef = useRef<number | null>(null);
  const lookupGenerationRef = useRef(0);
  /** Where the last navigation landed: the "from" of a navigation out of a result list. */
  const currentPlaceRef = useRef<NavigationPlace | null>(null);

  // Hover lookups repeat a lot: cache per position, and per line every symbol already seen.
  const definitionCacheRef = useRef(
    new Map<string, Promise<CodeNavigationDefinitionResult | null>>(),
  );
  const lineSymbolsRef = useRef(new Map<string, CodeNavigationDefinitionResult[]>());
  /**
   * What the caches belong to: a refreshed diff may mean edited working-tree
   * files, an edit in the editor moves every position after it.
   */
  const cacheOwnerRef = useRef<unknown>(null);

  /** The request for a position: an unsaved editor buffer stands in for its file on disk. */
  const requestOf = useCallback((position: Position): CodeNavigationPositionInput | null => {
    const { cwd, editor } = surfaceRef.current;
    if (!cwd) return null;
    const unsaved =
      editor?.dirty && position.revision._tag === "workingTree" && position.path === editor.path;
    return { cwd, ...position, ...(unsaved ? { content: editor.text } : {}) };
  }, []);

  const resolve = useCallback(
    (position: Position) => {
      const { environmentId, files, editor } = surfaceRef.current;
      const input = requestOf(position);
      if (!environmentId || !input) return Promise.resolve(null);
      const owner = editor ? editor.text : files;
      if (cacheOwnerRef.current !== owner || definitionCacheRef.current.size > CACHE_LIMIT) {
        cacheOwnerRef.current = owner;
        definitionCacheRef.current.clear();
        lineSymbolsRef.current.clear();
      }
      const lineKey = `${revisionKey(position.revision)}|${position.path}|${position.line}`;
      const known = lineSymbolsRef.current
        .get(lineKey)
        ?.find(
          (result) =>
            result.symbol !== null &&
            position.column >= result.symbol.column &&
            position.column < result.symbol.endColumn,
        );
      if (known) return Promise.resolve(known);
      const key = `${lineKey}|${position.column}`;
      const cached = definitionCacheRef.current.get(key);
      if (cached) return cached;
      const pending = resolveDefinitionCommand({ environmentId, input }).then((result) => {
        if (result._tag !== "Success") {
          definitionCacheRef.current.delete(key);
          return null;
        }
        if (result.value.symbol) {
          const symbols = lineSymbolsRef.current.get(lineKey) ?? [];
          symbols.push(result.value);
          lineSymbolsRef.current.set(lineKey, symbols);
        }
        return result.value;
      });
      definitionCacheRef.current.set(key, pending);
      return pending;
    },
    [requestOf, resolveDefinitionCommand],
  );

  const hoverOf = useCallback((props: TokenProps, context?: TokenContext): Hover | null => {
    const item = context?.item;
    const base = {
      token: props.tokenElement,
      lineCharStart: props.lineCharStart,
      line: props.lineNumber,
    };
    if (item?.type === "diff") {
      const side = props.side ?? "additions";
      const revision = revisionForSide(surfaceRef.current.revisions, side);
      if (!revision) return null;
      const path = pathForSide(item.fileDiff, side);
      return {
        ...base,
        revision,
        path,
        place: { kind: "diff", path: item.fileDiff.name, side, line: props.lineNumber },
      };
    }
    const file = fileViewRef.current;
    const editorPath = surfaceRef.current.editor?.path;
    // The editor is a standalone file without item context; the file view covers it while open.
    if (!file && !item && editorPath) {
      return {
        ...base,
        revision: WORKING_TREE,
        path: editorPath,
        place: { kind: "editor", path: editorPath, line: props.lineNumber, column: 0 },
      };
    }
    if (!file) return null;
    return {
      ...base,
      revision: file.revision,
      path: file.path,
      place: { kind: "file", revision: file.revision, path: file.path, line: props.lineNumber },
    };
  }, []);

  /** The editor's caret as a navigation origin, while the editor is what the user looks at. */
  const caretOrigin = useCallback((): { origin: Origin; position: Position } | null => {
    const { editor } = surfaceRef.current;
    const caret = editor?.caret();
    if (!editor?.path || !caret || fileViewRef.current) return null;
    const position = { revision: WORKING_TREE, path: editor.path, ...caret };
    return {
      origin: {
        revision: WORKING_TREE,
        path: editor.path,
        place: { kind: "editor", path: editor.path, ...caret },
      },
      position,
    };
  }, []);

  const cancelLookup = useCallback(() => {
    if (lookupTimerRef.current !== null) window.clearTimeout(lookupTimerRef.current);
    lookupTimerRef.current = null;
    lookupGenerationRef.current++;
  }, []);

  const clearHoverLink = useCallback(() => {
    cancelLookup();
    clearLink();
  }, [cancelLookup]);

  /** Underlines the hovered word once the server says it leads somewhere. */
  const scheduleLookup = useCallback(() => {
    cancelLookup();
    const generation = lookupGenerationRef.current;
    lookupTimerRef.current = window.setTimeout(() => {
      const hover = hoverRef.current;
      if (!hover || !modifierRef.current) return clearLink();
      const { x, y } = pointerRef.current;
      const position = positionOf(hover, x, y);
      void resolve(position).then((result) => {
        if (generation !== lookupGenerationRef.current || hoverRef.current !== hover) return;
        const symbol = result?.symbol;
        const line = lineElementOf(hover.token);
        if (
          !symbol ||
          !line ||
          (result.definitions.length === 0 && !result.isDefinition) ||
          position.column < symbol.column ||
          position.column >= symbol.endColumn
        ) {
          return clearLink();
        }
        showLink(line, symbol.column, symbol.endColumn);
      });
    }, HOVER_DEBOUNCE_MS);
  }, [cancelLookup, resolve]);

  const revealInDiff = useCallback(
    (path: string, side: DiffSide, line: number, byName: boolean) => {
      const { files, codeView } = surfaceRef.current;
      const file = files.find((candidate) =>
        byName ? candidate.fileDiff.name === path : pathForSide(candidate.fileDiff, side) === path,
      );
      const id = file?.id ?? file?.fileKey;
      if (!file || !id || !codeView || file.collapsed || !isLineInDiff(file.fileDiff, side, line)) {
        return false;
      }
      setFileView(null);
      codeView.scrollTo({ type: "line", id, lineNumber: line, side, align: "center" });
      if (container) flashLine(container, file.fileDiff.name, side, line);
      currentPlaceRef.current = { kind: "diff", path: file.fileDiff.name, side, line };
      return true;
    },
    [container],
  );

  /** Opens a working-tree file in the editor, from the editor itself. */
  const openEditorPlace = useCallback((path: string, line: number, column: number) => {
    const { editor, openInEditor } = surfaceRef.current;
    if (!editor || !openInEditor?.(path, line, column)) return false;
    setFileView(null);
    currentPlaceRef.current = { kind: "editor", path, line, column };
    return true;
  }, []);

  const openPlace = useCallback(
    (revision: CodeNavigationRevision, path: string, line: number, column: number) => {
      if (revision._tag === "workingTree" && openEditorPlace(path, line, column)) return;
      const side = sideOfRevision(surfaceRef.current.revisions, revision);
      if (side && revealInDiff(path, side, line, false)) return;
      setFileView({ revision, path, line });
      currentPlaceRef.current = { kind: "file", revision, path, line };
    },
    [openEditorPlace, revealInDiff],
  );

  const navigate = useCallback(
    (location: CodeNavigationLocation, revision: CodeNavigationRevision, from: NavigationPlace) => {
      setHistory(recordNavigation(historyRef.current, from));
      setPicker(null);
      openPlace(revision, location.path, location.line, location.column);
    },
    [openPlace, setHistory],
  );

  /** Where the user is now, to come back to after going back or forward. */
  const currentPlace = useCallback(
    (): NavigationPlace | null => caretOrigin()?.origin.place ?? currentPlaceRef.current,
    [caretOrigin],
  );

  const step = useCallback(
    (direction: "back" | "forward") => {
      const { place, history: next } = stepHistory(historyRef.current, direction, currentPlace());
      if (!place) return;
      setHistory(next);
      setPicker(null);
      if (place.kind === "diff") {
        if (!revealInDiff(place.path, place.side, place.line, true)) setFileView(null);
        return;
      }
      if (place.kind === "editor") {
        if (!openEditorPlace(place.path, place.line, place.column)) {
          setFileView({ revision: WORKING_TREE, path: place.path, line: place.line });
        }
        return;
      }
      setFileView({ revision: place.revision, path: place.path, line: place.line });
      currentPlaceRef.current = place;
    },
    [currentPlace, openEditorPlace, revealInDiff, setHistory],
  );
  const goBack = useCallback(() => step("back"), [step]);
  const goForward = useCallback(() => step("forward"), [step]);

  const showReferences = useCallback(
    (origin: Origin, position: Position) => {
      const { environmentId } = surfaceRef.current;
      const input = requestOf(position);
      if (!environmentId || !input) return;
      const from = placeAt(origin, position);
      setPicker(null);
      currentPlaceRef.current = from;
      const request = Date.now();
      setReferences({
        request,
        revision: origin.revision,
        from,
        result: null,
        error: null,
      });
      void findReferencesCommand({ environmentId, input }).then((result) => {
        setReferences((current) =>
          current?.request !== request
            ? current
            : result._tag === "Success"
              ? { ...current, result: result.value }
              : { ...current, error: "Could not find references." },
        );
      });
    },
    [findReferencesCommand, requestOf],
  );

  const goToDefinition = useCallback(
    (origin: Origin, position: Position, x: number, y: number) => {
      void resolve(position).then((result) => {
        if (!result?.symbol) return;
        if (result.isDefinition) return showReferences(origin, position);
        const [first, ...others] = result.definitions;
        if (!first) return;
        const from = placeAt(origin, position);
        if (others.length === 0) return navigate(first, origin.revision, from);
        setPicker({ x, y, revision: origin.revision, locations: result.definitions, from });
      });
    },
    [navigate, resolve, showReferences],
  );

  const options = useMemo(
    () => ({
      onTokenEnter: (props: TokenProps, event: PointerEvent, context?: TokenContext) => {
        hoverRef.current = hoverOf(props, context);
        pointerRef.current = { x: event.clientX, y: event.clientY, inside: true };
        modifierRef.current = isNavigationModifier(event, MAC);
        if (hoverRef.current && modifierRef.current) scheduleLookup();
        else clearHoverLink();
      },
      onTokenLeave: () => {
        hoverRef.current = null;
        clearHoverLink();
      },
      onTokenClick: (props: TokenProps, event: MouseEvent, context?: TokenContext) => {
        if (!isNavigationModifier(event, MAC)) return;
        const hover = hoverOf(props, context);
        if (!hover) return;
        event.preventDefault();
        clearHoverLink();
        goToDefinition(
          hover,
          positionOf(hover, event.clientX, event.clientY),
          event.clientX,
          event.clientY,
        );
      },
    }),
    [clearHoverLink, goToDefinition, hoverOf, scheduleLookup],
  );

  // Pointer, mouse-back and context menu inside the surface.
  useEffect(() => {
    if (!container) return;
    const onPointerMove = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY, inside: true };
      const held = isNavigationModifier(event, MAC);
      if (held !== modifierRef.current) modifierRef.current = held;
      if (held && hoverRef.current) scheduleLookup();
      else if (!held) clearHoverLink();
    };
    const onPointerLeave = () => {
      pointerRef.current = { ...pointerRef.current, inside: false };
      hoverRef.current = null;
      clearHoverLink();
    };
    const onMouseUp = (event: MouseEvent) => {
      const back = isBackMouseButton(event.button);
      if (!back && !isForwardMouseButton(event.button)) return;
      const { back: behind, forward: ahead } = historyRef.current;
      if ((back ? behind : ahead).length === 0) return;
      event.preventDefault();
      step(back ? "back" : "forward");
    };
    // In the editor Cmd/Ctrl+click navigates instead of adding a cursor, and
    // Alt+click adds the cursor instead, as in VS Code. Pierre's editor listens
    // inside its shadow root, so the container's capture phase comes first.
    const editing = surfaceRef.current.editor !== undefined;
    const onEditorPointerDown = (event: PointerEvent) => {
      if (remappedEvents.has(event) || event.button !== 0 || !isCodeTarget(event)) return;
      if (isNavigationModifier(event, MAC)) {
        event.stopPropagation();
        return;
      }
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.stopPropagation();
      const remapped = new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        button: event.button,
        buttons: event.buttons,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
        metaKey: MAC,
        ctrlKey: !MAC,
      });
      remappedEvents.add(remapped);
      event.composedPath()[0]?.dispatchEvent(remapped);
    };
    const onEditorMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !isNavigationModifier(event, MAC) || !isCodeTarget(event)) return;
      // Keeps the caret and selection where they are; the click still reaches the token.
      event.preventDefault();
      event.stopPropagation();
    };
    const onContextMenu = (event: MouseEvent) => {
      const hover = hoverRef.current;
      // The editor keeps its Cut/Copy/Paste menu; F12 and Shift+F12 navigate there.
      if (!hover || hover.place.kind === "editor") return;
      if (!event.composedPath().includes(hover.token)) return;
      const api = readLocalApi();
      if (!api) return;
      event.preventDefault();
      event.stopPropagation();
      const position = positionOf(hover, event.clientX, event.clientY);
      const { clientX: x, clientY: y } = event;
      void api.contextMenu
        .show(
          [
            { id: "definition", label: "Go to Definition" },
            { id: "references", label: "Find All References" },
          ],
          { x, y },
        )
        .then((choice) => {
          if (choice === "definition") goToDefinition(hover, position, x, y);
          if (choice === "references") showReferences(hover, position);
        });
    };
    container.addEventListener("pointermove", onPointerMove, { passive: true });
    container.addEventListener("pointerleave", onPointerLeave);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("contextmenu", onContextMenu);
    if (editing) {
      container.addEventListener("pointerdown", onEditorPointerDown, true);
      container.addEventListener("mousedown", onEditorMouseDown, true);
    }
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("pointerdown", onEditorPointerDown, true);
      container.removeEventListener("mousedown", onEditorMouseDown, true);
    };
  }, [clearHoverLink, container, goToDefinition, scheduleLookup, showReferences, step]);

  // The modifier, shortcuts and window blur.
  const overlayOpen = fileView !== null || picker !== null || references !== null;
  useEffect(() => {
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isNavigationModifierKey(event.key, MAC)) {
        modifierRef.current = true;
        if (hoverRef.current) scheduleLookup();
        return;
      }
      const editorFocused =
        surfaceRef.current.editor !== undefined && container.contains(document.activeElement);
      const active = pointerRef.current.inside || overlayOpen || editorFocused;
      if (!active) return;
      // Typing in the editor keeps Cmd+[ and Cmd+] for outdent and indent.
      const inEditor = editorFocused && !fileView;
      const { back, forward } = historyRef.current;
      const caret = editorFocused ? caretOrigin() : null;
      const hover = hoverRef.current;
      const { x, y } = pointerRef.current;
      if (isBackShortcut(event, MAC, inEditor) && back.length > 0) {
        goBack();
      } else if (isForwardShortcut(event, MAC, inEditor) && forward.length > 0) {
        goForward();
      } else if (isReferencesShortcut(event) && (caret || hover)) {
        if (caret) showReferences(caret.origin, caret.position);
        else if (hover) showReferences(hover, positionOf(hover, x, y));
      } else if (isDefinitionShortcut(event) && (caret || hover)) {
        if (caret) {
          const anchor = container.getBoundingClientRect();
          goToDefinition(caret.origin, caret.position, anchor.left + 24, anchor.top + 24);
        } else if (hover) {
          goToDefinition(hover, positionOf(hover, x, y), x, y);
        }
      } else if (event.key === "Escape" && overlayOpen) {
        if (picker) setPicker(null);
        else if (references) setReferences(null);
        else setFileView(null);
      } else {
        return;
      }
      // Captured ahead of the app's own Cmd+[ (browser back), F12 and Escape handlers.
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isNavigationModifierKey(event.key, MAC)) return;
      modifierRef.current = false;
      clearHoverLink();
    };
    const onBlur = () => {
      modifierRef.current = false;
      clearHoverLink();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    caretOrigin,
    clearHoverLink,
    container,
    fileView,
    goBack,
    goForward,
    goToDefinition,
    overlayOpen,
    picker,
    references,
    scheduleLookup,
    showReferences,
  ]);

  useEffect(() => clearHoverLink, [clearHoverLink]);

  const openReference = useCallback(
    (location: CodeNavigationLocation) => {
      if (references) {
        navigate(location, references.revision, currentPlaceRef.current ?? references.from);
      }
    },
    [navigate, references],
  );

  // Other surfaces offer the editor for working-tree files, without leaving their history.
  const { openInEditor } = surface;
  const openFileViewInEditor =
    fileView?.revision._tag === "workingTree" && openInEditor && !surface.editor
      ? () => {
          if (openInEditor(fileView.path, fileView.line, 0)) setFileView(null);
        }
      : undefined;

  const overlay: ReactNode = (
    <>
      {fileView && surface.environmentId && surface.cwd ? (
        <CodeNavigationFileView
          environmentId={surface.environmentId}
          cwd={surface.cwd}
          target={fileView}
          options={options}
          canGoBack={history.back.length > 0}
          onBack={goBack}
          onClose={() => setFileView(null)}
          onOpenInEditor={openFileViewInEditor}
        />
      ) : history.back.length > 0 ? (
        <CodeNavigationBackButton onBack={goBack} />
      ) : null}
      {references ? (
        <CodeNavigationReferences
          state={references}
          onOpen={openReference}
          onClose={() => setReferences(null)}
        />
      ) : null}
      {picker ? (
        <CodeNavigationPicker
          x={picker.x}
          y={picker.y}
          locations={picker.locations}
          onOpen={(location) => navigate(location, picker.revision, picker.from)}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </>
  );

  return { mount: setContainer, options, overlay };
}
