/**
 * Fork: VS Code-style code navigation for a diff viewer. Cmd/Ctrl+hover
 * underlines what has a definition, Cmd/Ctrl+click goes there (a picker when
 * there are several, references when the word is the definition), Shift+F12
 * and the context menu find references, and Cmd+[ / Alt+Left / mouse back
 * return. Targets inside the diff scroll into view; others open a read-only
 * file view at the same revision.
 *
 * A surface mounts it with: `mount` as the ref of the element around the viewer
 * (positioned, it hosts the overlay), `options` spread into the viewer's
 * options, and `overlay` rendered inside the container. The underline's CSS
 * ships with every viewer (`StyledDiffCodeView`).
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
  isBackMouseButton,
  isBackShortcut,
  isLineInDiff,
  isNavigationModifier,
  isNavigationModifierKey,
  isReferencesShortcut,
  type NavigationPlace,
  pathForSide,
  popPlace,
  pushPlace,
  revisionForSide,
  revisionKey,
  sideOfRevision,
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

export interface CodeNavigationSurface {
  readonly environmentId: EnvironmentId | null | undefined;
  readonly cwd: string | null | undefined;
  readonly revisions: DiffRevisions;
  readonly files: ReadonlyArray<CodeNavigationFile>;
  readonly codeView: { scrollTo(target: CodeViewScrollTarget): void } | null;
}

/** The trailing context Pierre's CodeView passes to item callbacks. */
export interface TokenContext {
  readonly item:
    | { readonly type: "diff"; readonly fileDiff: FileDiffMetadata }
    | { readonly type: "file"; readonly file: { readonly name: string } };
}
export type TokenProps = TokenEventBase & { readonly side?: DiffSide };

interface Hover {
  readonly token: HTMLElement;
  readonly lineCharStart: number;
  readonly revision: CodeNavigationRevision;
  readonly path: string;
  readonly line: number;
  readonly place: NavigationPlace;
}

type Picker = {
  readonly x: number;
  readonly y: number;
  readonly revision: CodeNavigationRevision;
  readonly locations: ReadonlyArray<CodeNavigationLocation>;
  readonly from: NavigationPlace;
};

/** The hovered position, at the character under the pointer. */
const positionOf = (hover: Hover, x: number, y: number) => ({
  revision: hover.revision,
  path: hover.path,
  line: hover.line,
  column: columnAtPoint(hover.token, hover.lineCharStart, x, y),
});

const MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

export function useCodeNavigation(surface: CodeNavigationSurface) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fileView, setFileView] = useState<FileViewTarget | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [references, setReferences] = useState<ReferencesState | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<NavigationPlace>>([]);
  // Event handlers read the latest values without re-subscribing.
  const surfaceRef = useRef(surface);
  const fileViewRef = useRef(fileView);
  const historyRef = useRef(history);
  useLayoutEffect(() => {
    surfaceRef.current = surface;
    fileViewRef.current = fileView;
    historyRef.current = history;
  });

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
  /** The diff the caches belong to: a refreshed diff may mean edited working-tree files. */
  const cacheOwnerRef = useRef<object | null>(null);

  const resolve = useCallback(
    (position: Omit<CodeNavigationPositionInput, "cwd">) => {
      const { environmentId, cwd, files } = surfaceRef.current;
      if (!environmentId || !cwd) return Promise.resolve(null);
      if (cacheOwnerRef.current !== files || definitionCacheRef.current.size > CACHE_LIMIT) {
        cacheOwnerRef.current = files;
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
      const pending = resolveDefinitionCommand({
        environmentId,
        input: { cwd, ...position },
      }).then((result) => {
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
    [resolveDefinitionCommand],
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
    if (!file) return null;
    return {
      ...base,
      revision: file.revision,
      path: file.path,
      place: { kind: "file", revision: file.revision, path: file.path, line: props.lineNumber },
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

  const openPlace = useCallback(
    (revision: CodeNavigationRevision, path: string, line: number) => {
      const side = sideOfRevision(surfaceRef.current.revisions, revision);
      if (side && revealInDiff(path, side, line, false)) return;
      setFileView({ revision, path, line });
      currentPlaceRef.current = { kind: "file", revision, path, line };
    },
    [revealInDiff],
  );

  const navigate = useCallback(
    (location: CodeNavigationLocation, revision: CodeNavigationRevision, from: NavigationPlace) => {
      setHistory((current) => pushPlace(current, from));
      setPicker(null);
      openPlace(revision, location.path, location.line);
    },
    [openPlace],
  );

  const goBack = useCallback(() => {
    const { place, history: rest } = popPlace(historyRef.current);
    if (!place) return;
    setHistory(rest);
    setPicker(null);
    if (place.kind === "diff") {
      if (!revealInDiff(place.path, place.side, place.line, true)) setFileView(null);
      return;
    }
    setFileView({ revision: place.revision, path: place.path, line: place.line });
    currentPlaceRef.current = place;
  }, [revealInDiff]);

  const showReferences = useCallback(
    (hover: Hover, position: Omit<CodeNavigationPositionInput, "cwd">) => {
      const { environmentId, cwd } = surfaceRef.current;
      if (!environmentId || !cwd) return;
      setPicker(null);
      currentPlaceRef.current = hover.place;
      const request = Date.now();
      setReferences({
        request,
        revision: hover.revision,
        from: hover.place,
        result: null,
        error: null,
      });
      void findReferencesCommand({ environmentId, input: { cwd, ...position } }).then((result) => {
        setReferences((current) =>
          current?.request !== request
            ? current
            : result._tag === "Success"
              ? { ...current, result: result.value }
              : { ...current, error: "Could not find references." },
        );
      });
    },
    [findReferencesCommand],
  );

  const goToDefinition = useCallback(
    (hover: Hover, position: Omit<CodeNavigationPositionInput, "cwd">, x: number, y: number) => {
      void resolve(position).then((result) => {
        if (!result?.symbol) return;
        if (result.isDefinition) return showReferences(hover, position);
        const [first, ...others] = result.definitions;
        if (!first) return;
        if (others.length === 0) return navigate(first, hover.revision, hover.place);
        setPicker({
          x,
          y,
          revision: hover.revision,
          locations: result.definitions,
          from: hover.place,
        });
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
      if (!isBackMouseButton(event.button) || historyRef.current.length === 0) return;
      event.preventDefault();
      goBack();
    };
    const onContextMenu = (event: MouseEvent) => {
      const hover = hoverRef.current;
      if (!hover || !event.composedPath().includes(hover.token)) return;
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
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("contextmenu", onContextMenu);
    };
  }, [clearHoverLink, container, goBack, goToDefinition, scheduleLookup, showReferences]);

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
      const active = pointerRef.current.inside || overlayOpen;
      if (!active) return;
      if (isBackShortcut(event, MAC) && historyRef.current.length > 0) {
        goBack();
      } else if (isReferencesShortcut(event) && hoverRef.current) {
        const { x, y } = pointerRef.current;
        showReferences(hoverRef.current, positionOf(hoverRef.current, x, y));
      } else if (event.key === "Escape" && overlayOpen) {
        if (picker) setPicker(null);
        else if (references) setReferences(null);
        else setFileView(null);
      } else {
        return;
      }
      // Captured ahead of the app's own Cmd+[ (browser back) and Escape handlers.
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
    clearHoverLink,
    container,
    goBack,
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

  const overlay: ReactNode = (
    <>
      {fileView && surface.environmentId && surface.cwd ? (
        <CodeNavigationFileView
          environmentId={surface.environmentId}
          cwd={surface.cwd}
          target={fileView}
          options={options}
          canGoBack={history.length > 0}
          onBack={goBack}
          onClose={() => setFileView(null)}
        />
      ) : history.length > 0 ? (
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
