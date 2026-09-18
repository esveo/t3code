import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { cn, newThreadId } from "~/lib/utils";
import { openCommandPalette } from "../../commandPaletteBus";
import { readProjects, readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { useSplitThreadStore } from "../../splitThreadStore";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { buildGridLayout, recommendGrid, ROUTE_LEAF_ID, type GridSize } from "./splitLayout.logic";

const PICKER_COLUMNS = 8;
const PICKER_ROWS = 6;

let arrangeIdCounter = 0;
const nextArrangeId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-a${++arrangeIdCounter}`;

/** The chat grid's size, or the window minus the sidebar when no grid is shown. */
function measureChatArea(): { width: number; height: number } {
  const grid = document.querySelector<HTMLElement>("[data-chat-grid]");
  if (grid) {
    const rect = grid.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { width: rect.width, height: rect.height };
  }
  const sidebarWidth =
    document.querySelector<HTMLElement>("[data-app-sidebar]")?.getBoundingClientRect().width ?? 0;
  return { width: window.innerWidth - sidebarWidth, height: window.innerHeight };
}

/**
 * Sidebar header button that arranges the pinned and active threads in a
 * grid. A table-style picker preselects the suggested grid; any other
 * columns × rows can be chosen before confirming. Confirming arranges the
 * open sessions alone, or fills the cells they leave free with new empty
 * threads in a project picked from the command palette (threads always belong
 * to a project).
 */
export function AutoArrangeButton({
  threads,
}: {
  /** Pinned then active threads, in sidebar order. */
  threads: readonly EnvironmentThreadShell[];
}) {
  const navigate = useNavigate();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const setLayout = useSplitThreadStore((state) => state.setLayout);
  const setActiveLeaf = useSplitThreadStore((state) => state.setActiveLeaf);
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState({ width: 1, height: 1 });
  const [selected, setSelected] = useState<GridSize>({ columns: 1, rows: 1 });
  const [hovered, setHovered] = useState<GridSize | null>(null);
  // Focus the confirm button, not the first grid cell, so opening the picker
  // keeps the suggested grid shown.
  const arrangeButtonRef = useRef<HTMLButtonElement>(null);

  const suggested = useMemo(
    () => recommendGrid(threads.length, area.width, area.height),
    [area, threads.length],
  );
  const shown = hovered ?? selected;
  const capacity = shown.columns * shown.rows;
  const placedCount = Math.min(threads.length, capacity);
  const newCount = capacity - placedCount;

  const onOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const measured = measureChatArea();
      setArea(measured);
      setSelected(recommendGrid(threads.length, measured.width, measured.height));
      setHovered(null);
    }
    setOpen(nextOpen);
  };

  const applyLayout = (arranged: readonly ScopedThreadRef[], grid: GridSize) => {
    const routeThread = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
    const { layout, navigateTo } = buildGridLayout({
      threads: arranged,
      routeThread,
      grid,
      makeId: nextArrangeId,
    });
    setLayout(layout);
    setActiveLeaf(ROUTE_LEAF_ID);
    if (navigateTo) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(navigateTo),
      });
    }
  };

  /** Creates `count` empty threads in a project and resolves once the client knows them. */
  const createEmptyThreads = async (
    projectRef: ScopedProjectRef,
    count: number,
  ): Promise<ScopedThreadRef[] | null> => {
    const project = readProjects().find(
      (candidate) =>
        candidate.environmentId === projectRef.environmentId &&
        candidate.id === projectRef.projectId,
    );
    const serverSettings =
      environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const projectSettings = resolveProjectSettings(
      serverSettings,
      projectRef.projectId,
      project,
    ).settings;
    // New threads start like the sessions being arranged, unless the project
    // pins its own model.
    const template = threads[0] ?? null;
    const modelSelection = projectSettings.defaultModelSelection ?? template?.modelSelection;
    if (!modelSelection) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create threads",
          description: "Pick a default model for this project first.",
        }),
      );
      return null;
    }
    const refs: ScopedThreadRef[] = [];
    for (let index = 0; index < count; index++) {
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: projectRef.environmentId,
        input: {
          threadId,
          projectId: projectRef.projectId,
          title: "New thread",
          modelSelection,
          runtimeMode: projectSettings.defaultRuntimeMode,
          interactionMode: template?.interactionMode ?? "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      if (result._tag === "Failure") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create threads",
            description: `Created ${refs.length} of ${count}.`,
          }),
        );
        break;
      }
      refs.push(scopeThreadRef(projectRef.environmentId, threadId));
    }
    // Panes close threads the client does not know, so wait for them to arrive.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (refs.every((ref) => readThreadShell(ref) !== null)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return refs;
  };

  /**
   * Arranges the sessions that are already open. `fillWithNew` decides what
   * happens to cells they do not fill: leave them out of the grid, or create
   * that many threads in a project the user picks.
   */
  const arrange = (fillWithNew: boolean) => {
    const grid = selected;
    const capacity = grid.columns * grid.rows;
    const existing = threads
      .slice(0, capacity)
      .map((thread) => scopeThreadRef(thread.environmentId, thread.id));
    setOpen(false);
    const missing = capacity - existing.length;
    if (!fillWithNew || missing <= 0) {
      applyLayout(existing, grid);
      return;
    }
    openCommandPalette({
      open: "new-thread-in",
      onProjectPicked: (projectRef) => {
        void createEmptyThreads(projectRef, missing).then((created) => {
          if (created) applyLayout([...existing, ...created], grid);
        });
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<SidebarHeaderIconButton label="Auto arrange" />}>
        <LayoutGridIcon />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="w-80" initialFocus={arrangeButtonRef}>
        <div className="flex flex-col gap-3">
          <div>
            <div className="font-medium text-sm">Auto arrange</div>
            <div className="text-muted-foreground text-xs">
              {threads.length} pinned and active {threads.length === 1 ? "session" : "sessions"}.
              The suggested grid is preselected; click another to change it. “Arrange new” fills the
              cells they leave free with new threads.
            </div>
          </div>

          <div
            className="grid w-fit gap-1"
            style={{ gridTemplateColumns: `repeat(${PICKER_COLUMNS}, 1.25rem)` }}
            onPointerLeave={() => setHovered(null)}
            role="grid"
            aria-label="Grid size"
          >
            {Array.from({ length: PICKER_ROWS }, (_, row) =>
              Array.from({ length: PICKER_COLUMNS }, (_, column) => {
                const size = { columns: column + 1, rows: row + 1 };
                const inShown = column < shown.columns && row < shown.rows;
                const isSuggested = column + 1 === suggested.columns && row + 1 === suggested.rows;
                return (
                  <button
                    key={`${row}:${column}`}
                    type="button"
                    role="gridcell"
                    aria-label={`${size.columns} columns, ${size.rows} rows`}
                    aria-selected={selected.columns === size.columns && selected.rows === size.rows}
                    className={cn(
                      "size-5 rounded-[3px] border transition-colors",
                      inShown
                        ? "border-primary/70 bg-primary/25"
                        : "border-border bg-muted/40 hover:border-primary/40",
                      isSuggested && "ring-1 ring-primary ring-offset-1 ring-offset-popover",
                    )}
                    onPointerEnter={() => setHovered(size)}
                    onClick={() => setSelected(size)}
                  />
                );
              }),
            )}
          </div>

          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium">
              {shown.columns} × {shown.rows}
              {shown.columns === suggested.columns && shown.rows === suggested.rows
                ? " (suggested)"
                : ""}
            </span>
            <span
              className={cn(
                "text-muted-foreground",
                placedCount < threads.length && "text-warning",
              )}
            >
              {placedCount < threads.length
                ? `Arranges ${placedCount} of ${threads.length}`
                : newCount > 0
                  ? `${placedCount} open, ${newCount} free ${newCount === 1 ? "cell" : "cells"}`
                  : `${placedCount} ${placedCount === 1 ? "pane" : "panes"}`}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              ref={arrangeButtonRef}
              size="sm"
              variant="outline"
              onClick={() => arrange(false)}
            >
              Arrange existing
            </Button>
            <Button size="sm" disabled={newCount === 0} onClick={() => arrange(true)}>
              Arrange new
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
