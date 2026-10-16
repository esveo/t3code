import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useThreadShellsForProjectRefs } from "../../state/entities";
import { EsveoSettingBadge } from "../esveoSettings/EsveoSettingBadge";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { Label } from "../ui/label";
import { SelectButton } from "../ui/select";
import { scheduledTaskThreadOptions, withScheduledTaskThread } from "./scheduledTaskLocation.logic";
import { SpawnAsSubthreadField } from "./SpawnAsSubthreadField";

const NEW_THREAD = "__new_thread__";
const NEW_THREAD_LABEL = "New thread each run";

interface LocationValue {
  readonly projectId: string;
  readonly threadId: string;
  readonly spawnAsSubthread: boolean;
}

/**
 * Fork (esveo): picks where an automation runs — a new thread each run or an
 * existing thread of the selected project — and, for a thread, whether each
 * run spawns a subthread of it.
 */
export function ScheduledTaskLocationField<D extends LocationValue>(props: {
  readonly environmentId: EnvironmentId;
  /** The project the task runs in, which may still be the form's fallback. */
  readonly projectId: string;
  readonly draft: D;
  readonly onDraftChange: (update: (current: D) => D) => void;
}) {
  const { environmentId, projectId, draft, onDraftChange } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projectRefs = useMemo(
    () => (projectId === "" ? [] : [{ environmentId, projectId: projectId as ProjectId }]),
    [environmentId, projectId],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const options = useMemo(
    () => (open ? scheduledTaskThreadOptions(threads, query) : []),
    [open, threads, query],
  );
  const selected = threads.find((thread) => thread.id === draft.threadId);
  // A bound thread missing from the loaded list (archived, deleted, or not
  // synced yet) still shows, so saving does not silently drop the binding.
  const triggerLabel =
    draft.threadId === ""
      ? NEW_THREAD_LABEL
      : selected
        ? `${selected.title}${selected.archivedAt === null ? "" : " (archived)"}`
        : `Thread ${draft.threadId}`;
  const items = [
    ...(query.trim() === "" ? [NEW_THREAD] : []),
    ...options.map((thread) => thread.id as string),
  ];
  const selectedValue = draft.threadId === "" ? NEW_THREAD : draft.threadId;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setQuery("");
  };

  return (
    <>
      <div className="space-y-1.5">
        <span className="inline-flex items-center gap-1.5">
          <Label htmlFor="scheduled-task-location">Runs in</Label>
          <EsveoSettingBadge />
        </span>
        <Combobox
          items={items}
          filteredItems={items}
          filter={null}
          autoHighlight
          open={open}
          onOpenChange={handleOpenChange}
          value={selectedValue}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            setOpen(false);
            // Pins the project, so a later project change can tell the thread was its own.
            onDraftChange((current) =>
              withScheduledTaskThread({ ...current, projectId }, next === NEW_THREAD ? "" : next),
            );
          }}
        >
          <ComboboxTrigger
            id="scheduled-task-location"
            render={<SelectButton size="sm" />}
            disabled={projectId === ""}
          >
            <span className="min-w-0 truncate">{triggerLabel}</span>
          </ComboboxTrigger>
          <ComboboxPopup align="start" side="bottom" className="w-80">
            <ComboboxSearchInput
              aria-label="Search threads"
              placeholder="Search threads…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxList className="max-h-72">
              {items.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">No threads found.</p>
              ) : (
                items.map((value, index) => (
                  <ComboboxItem key={value} hideIndicator index={index} value={value}>
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        {value === NEW_THREAD
                          ? NEW_THREAD_LABEL
                          : (options.find((thread) => thread.id === value)?.title ?? value)}
                      </span>
                      {value === selectedValue ? (
                        <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : null}
                    </div>
                  </ComboboxItem>
                ))
              )}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </div>
      {draft.threadId ? (
        <SpawnAsSubthreadField
          checked={draft.spawnAsSubthread}
          onCheckedChange={(spawnAsSubthread) =>
            onDraftChange((current) => ({ ...current, spawnAsSubthread }))
          }
        />
      ) : null}
    </>
  );
}
