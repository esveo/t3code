import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ContextMenuItem, LocalApi, ThreadId } from "@t3tools/contracts";
import { MessageSquareIcon, NetworkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useProjects, useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Command, CommandInput, CommandItem, CommandList } from "../ui/command";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { coordinatorLinksEnvironment, useCoordinatorOf } from "./coordinatorLinks";
import {
  hasChildThreads,
  parentThreadCandidates,
  type ThreadParentMenuId,
  withThreadParentMenuItems,
} from "./threadParent.logic";

type Request = {
  readonly thread: EnvironmentThreadShell;
  readonly resolve: (parentThreadId: ThreadId | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

function requestParentThread(thread: EnvironmentThreadShell): Promise<ThreadId | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { thread, resolve } }));
}

function finish(parentThreadId: ThreadId | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(parentThreadId);
}

/** Fork: the coordinator picker behind "Assign to coordinator…". Mount once, next to the menu. */
export function ThreadParentDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <ThreadParentDialog thread={request.thread} /> : null;
}

function ThreadParentDialog({ thread }: { thread: EnvironmentThreadShell }) {
  const threads = useThreadShells();
  const coordinatorOf = useCoordinatorOf(threads);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const projectNames = new Map(
    projects
      .filter((project) => project.environmentId === thread.environmentId)
      .map((project) => [project.id, project.title]),
  );
  const coordinatorIds = new Set(
    threads.flatMap((t) => {
      const coordinatorId = coordinatorOf(t);
      return coordinatorId ? [coordinatorId] : [];
    }),
  );
  const search = query.trim().toLocaleLowerCase();
  const candidates = parentThreadCandidates(threads, thread, coordinatorOf).filter((candidate) =>
    `${candidate.title} ${projectNames.get(candidate.projectId) ?? ""}`
      .toLocaleLowerCase()
      .includes(search),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogTitle className="sr-only">Assign "{thread.title}" to a coordinator</DialogTitle>
        <Command
          mode="none"
          value={query}
          onValueChange={setQuery}
          aria-label="Choose a coordinator"
        >
          <CommandInput placeholder={`Coordinator for "${thread.title}"…`} />
          <CommandList className="max-h-80 overflow-y-auto">
            {candidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No thread can coordinate this one.
              </div>
            ) : (
              candidates.map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={candidate.id}
                  onClick={() => finish(candidate.id)}
                >
                  {coordinatorIds.has(candidate.id) ? (
                    <NetworkIcon aria-hidden className="size-4 shrink-0" />
                  ) : (
                    <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{candidate.title || "Untitled thread"}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {projectNames.get(candidate.projectId)}
                    </span>
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Fork: the thread menu's coordinator items and their actions. `showMenu`
 * shows a thread's menu with them added; `handle` runs a clicked one and
 * returns false for every other id, so the menu's own switch keeps the rest.
 */
export function useThreadParentActions() {
  const threads = useThreadShells();
  const coordinatorOf = useCoordinatorOf(threads);
  // Read when a menu opens, so the actions stay stable while threads change.
  const threadsRef = useRef({ threads, coordinatorOf });
  useEffect(() => {
    threadsRef.current = { threads, coordinatorOf };
  }, [coordinatorOf, threads]);
  const setCoordinator = useAtomCommand(coordinatorLinksEnvironment.set, {
    reportFailure: false,
  });

  const showMenu = useCallback(
    (api: LocalApi, thread: EnvironmentThreadShell) =>
      <Id extends string>(
        items: ReadonlyArray<ContextMenuItem<Id>>,
        position?: { x: number; y: number },
      ) =>
        api.contextMenu.show<Id | ThreadParentMenuId>(
          withThreadParentMenuItems(items, {
            hasParent: threadsRef.current.coordinatorOf(thread) !== null,
            hasChildren: hasChildThreads(
              threadsRef.current.threads,
              thread,
              threadsRef.current.coordinatorOf,
            ),
          }),
          position,
        ),
    [],
  );

  const handle = useCallback(
    async (id: string | null | undefined, thread: EnvironmentThreadShell): Promise<boolean> => {
      if (id !== "assign-parent" && id !== "detach-parent") return false;
      const parentThreadId = id === "assign-parent" ? await requestParentThread(thread) : null;
      if (id === "assign-parent" && parentThreadId === null) return true;
      const result = await setCoordinator({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, coordinatorThreadId: parentThreadId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              id === "assign-parent"
                ? "Could not assign the thread"
                : "Could not detach the thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      return true;
    },
    [setCoordinator],
  );

  return { showMenu, handle };
}
