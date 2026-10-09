/**
 * Fork: what code navigation shows over a diff — the definition picker, the
 * references list, the read-only file view and the back button.
 */
import type {
  CodeNavigationLocation,
  CodeNavigationReferencesResult,
  CodeNavigationRevision,
  EnvironmentId,
} from "@t3tools/contracts";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { ArrowLeftIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
import {
  StyledDiffCodeView,
  type StyledDiffCodeViewOptions,
} from "~/components/diffs/StyledDiffCodeView";
import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { isMacPlatform } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { groupByFile, type NavigationPlace, revisionKey } from "./codeNavigation.logic";
import { flashLine } from "./codeNavigationDom";
import { codeNavigationEnvironment } from "./codeNavigationState";

export interface FileViewTarget {
  readonly revision: CodeNavigationRevision;
  readonly path: string;
  readonly line: number;
}

export interface ReferencesState {
  readonly request: number;
  readonly revision: CodeNavigationRevision;
  readonly from: NavigationPlace;
  readonly result: CodeNavigationReferencesResult | null;
  readonly error: string | null;
}

const BACK_SHORTCUT =
  typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘[" : "Alt+←";

function revisionLabel(revision: CodeNavigationRevision) {
  switch (revision._tag) {
    case "workingTree":
      return "Working tree";
    case "git":
      return /^[0-9a-f]{40}$/i.test(revision.ref) ? revision.ref.slice(0, 8) : revision.ref;
    case "mergeBase":
      return `Merge base with ${revision.ref}`;
    case "checkpoint":
      return revision.turnCount === 0 ? "Before turn 1" : `After turn ${revision.turnCount}`;
  }
}

function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return { name: path.slice(slash + 1), directory: slash > 0 ? path.slice(0, slash) : "" };
}

function LocationRow({
  location,
  showPath,
  onOpen,
}: {
  readonly location: CodeNavigationLocation;
  readonly showPath: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      onClick={onOpen}
    >
      {showPath ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {location.path}:{location.line}
        </span>
      ) : (
        <span className="w-8 shrink-0 text-right font-mono text-2xs text-muted-foreground">
          {location.line}
        </span>
      )}
      <span className="min-w-0 truncate font-mono text-xs">{location.preview}</span>
    </button>
  );
}

/** Several definitions: pick one, like VS Code's peek. */
export function CodeNavigationPicker({
  x,
  y,
  locations,
  onOpen,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly locations: ReadonlyArray<CodeNavigationLocation>;
  readonly onOpen: (location: CodeNavigationLocation) => void;
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y + 14 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: y + 14 + height > window.innerHeight - 8 ? Math.max(8, y - height - 8) : y + 14,
    });
    element.querySelector("button")?.focus();
  }, [x, y]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Definitions"
      className="fixed z-50 flex max-h-72 w-[min(32rem,calc(100vw-16px))] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
      style={position}
    >
      <div className="shrink-0 border-b px-3 py-1.5 text-xs text-muted-foreground">
        {locations.length} definitions
      </div>
      <div className="min-h-0 overflow-y-auto py-1">
        {locations.map((location) => (
          <LocationRow
            key={`${location.path}:${location.line}:${location.column}`}
            location={location}
            showPath
            onOpen={() => onOpen(location)}
          />
        ))}
      </div>
    </div>
  );
}

/** Find All References: grouped by file, clicking one goes there and keeps the list open. */
export function CodeNavigationReferences({
  state,
  onOpen,
  onClose,
}: {
  readonly state: ReferencesState;
  readonly onOpen: (location: CodeNavigationLocation) => void;
  readonly onClose: () => void;
}) {
  const result = state.result;
  const groups = useMemo(() => (result ? groupByFile(result.references) : []), [result]);
  const count = result?.references.length ?? 0;
  return (
    <div
      role="dialog"
      aria-label="References"
      className="absolute inset-x-0 bottom-0 z-20 flex max-h-[45%] min-h-24 flex-col border-t bg-popover text-popover-foreground shadow-lg"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate">
          {result?.symbol ? (
            <>
              <span className="font-mono font-semibold">{result.symbol.name}</span>
              <span className="text-muted-foreground">
                {` · ${count}${result.truncated ? "+" : ""} ${count === 1 ? "reference" : "references"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">References</span>
          )}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          onClick={onClose}
          aria-label="Close references"
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {state.error ? (
          <p className="p-3 text-xs text-destructive">{state.error}</p>
        ) : !result ? (
          <p className="p-3 text-xs text-muted-foreground">Searching…</p>
        ) : count === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">No references found.</p>
        ) : (
          groups.map((group) => {
            const { name, directory } = splitPath(group.path);
            return (
              <section key={group.path}>
                <div className="sticky top-0 flex items-baseline gap-2 bg-popover px-3 pt-1.5 pb-0.5 text-xs">
                  <span className="font-medium">{name}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {group.locations.length}
                  </span>
                </div>
                {group.locations.map((location) => (
                  <LocationRow
                    key={`${location.line}:${location.column}`}
                    location={location}
                    showPath={false}
                    onOpen={() => onOpen(location)}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

export function CodeNavigationBackButton({ onBack }: { readonly onBack: () => void }) {
  return (
    <Button
      size="xs"
      variant="outline"
      className="absolute right-3 bottom-3 z-10"
      onClick={onBack}
      title={`Go back (${BACK_SHORTCUT})`}
    >
      <ArrowLeftIcon />
      Back
    </Button>
  );
}

const fileCache = new Map<string, { readonly contents: string; readonly truncated: boolean }>();

/** A file at a revision, read-only, with the target line in view and navigable again. */
export function CodeNavigationFileView({
  environmentId,
  cwd,
  target,
  options,
  canGoBack,
  onBack,
  onClose,
  onOpenInEditor,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly target: FileViewTarget;
  readonly options: StyledDiffCodeViewOptions<undefined>;
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  /** Offered for working-tree files the built-in editor can open. */
  readonly onOpenInEditor?: (() => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const readFile = useAtomCommand(codeNavigationEnvironment.readFile, { reportFailure: false });
  const fileKey = `${cwd}|${revisionKey(target.revision)}|${target.path}`;
  // Commits never change; the working tree is read again on every visit.
  const cacheable = target.revision._tag !== "workingTree";
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly contents: string;
    readonly truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<{ readonly key: string; readonly message: string } | null>(
    null,
  );
  const file =
    loaded?.key === fileKey ? loaded : cacheable ? (fileCache.get(fileKey) ?? null) : null;
  const ready = file !== null;
  const { revision, path } = target;
  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    void readFile({ environmentId, input: { cwd, revision, path } }).then((result) => {
      if (cancelled) return;
      if (result._tag !== "Success") {
        return setError({ key: fileKey, message: "Could not read this file." });
      }
      const contents = { contents: result.value.contents, truncated: result.value.truncated };
      if (cacheable) {
        if (fileCache.size > 40) fileCache.clear();
        fileCache.set(fileKey, contents);
      }
      setLoaded({ key: fileKey, ...contents });
    });
    return () => {
      cancelled = true;
    };
  }, [cacheable, cwd, environmentId, fileKey, path, readFile, ready, revision]);

  const [viewer, setViewer] = useState<CodeViewHandle<undefined> | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready || !viewer) return;
    // A new target object is a new navigation, also to the line already shown.
    const line = target.line;
    const frame = requestAnimationFrame(() => {
      viewer.scrollTo({ type: "line", id: fileKey, lineNumber: line, align: "center" });
      if (bodyRef.current) flashLine(bodyRef.current, null, null, line);
    });
    return () => cancelAnimationFrame(frame);
  }, [fileKey, ready, target, viewer]);

  const items = useMemo(
    () =>
      file
        ? [
            {
              id: fileKey,
              type: "file" as const,
              file: { name: path, contents: file.contents, cacheKey: fileKey },
            },
          ]
        : [],
    [file, fileKey, path],
  );

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <header className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1 text-xs">
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!canGoBack}
          onClick={onBack}
          aria-label="Go back"
          title={`Go back (${BACK_SHORTCUT})`}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="min-w-0 truncate font-mono">{target.path}</span>
        <span className="shrink-0 text-muted-foreground">· {revisionLabel(target.revision)}</span>
        {file?.truncated ? (
          <span className="shrink-0 text-muted-foreground">· truncated</span>
        ) : null}
        <span className="ml-auto shrink-0 text-muted-foreground">Read-only</span>
        {onOpenInEditor ? (
          <Button size="xs" variant="ghost" onClick={onOpenInEditor} title="Open in editor">
            <SquarePenIcon />
            Edit
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close file">
          <XIcon />
        </Button>
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1">
        {error?.key === fileKey && !ready ? (
          <p className="p-4 text-xs text-destructive">{error.message}</p>
        ) : !ready ? (
          <DiffPanelLoadingState label="Loading file..." />
        ) : (
          <StyledDiffCodeView<undefined>
            className="h-full min-h-0 overflow-auto"
            items={items}
            viewerRef={setViewer}
            options={{
              ...options,
              disableFileHeader: true,
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              preferredHighlighter: PREFERRED_HIGHLIGHTER,
              themeType: resolvedTheme,
            }}
          />
        )}
      </div>
    </div>
  );
}
