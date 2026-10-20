import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useMemo, type ReactNode } from "react";
import type { SidebarSection } from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { SidebarChildThreads } from "../threadOrchestration/SidebarChildThreads";
import {
  CROSS_PROJECT_RUN_KEY,
  crossProjectCoordinatorKeys,
  type ChildThreadGroups,
} from "../threadOrchestration/childThreads.logic";
import { SidebarProjectRunHeader } from "./SidebarProjectRunHeader";
import type { SidebarProjectRunHeader as SidebarProjectRunHeaderInfo } from "./sidebarProjectRuns.logic";
import type { SidebarProjectRuns } from "./useSidebarProjectRuns";

/**
 * Fork: what the sidebar needs to gather threads into project runs and to
 * nest a coordinator's child threads under it. `Sidebar.tsx` calls this once
 * its project groups exist and threads the results through upstream's lists.
 */
export function useForkSidebarGroups(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Threads a coordinator started render under it, not as rows of their own. */
  childThreadGroups: ChildThreadGroups;
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
}) {
  const { threads, childThreadGroups, projectGroups } = input;
  // Coordinators whose work spans projects gather under "Cross-project".
  const crossProjectRunKeys = useMemo(
    () =>
      new Map(
        [...crossProjectCoordinatorKeys({ threads, groups: childThreadGroups })].map(
          (key) => [key, CROSS_PROJECT_RUN_KEY] as const,
        ),
      ),
    [childThreadGroups, threads],
  );
  // The logical project group behind each thread, for the run headers.
  const projectGroupByThreadProjectKey = useMemo(
    () =>
      new Map(
        projectGroups.flatMap((group) =>
          group.memberProjects.map(
            (project) => [`${project.environmentId}:${project.id}`, group] as const,
          ),
        ),
      ),
    [projectGroups],
  );
  return { crossProjectRunKeys, projectGroupByThreadProjectKey };
}

type RunSection = "active" | "settled";

/**
 * Fork: the rows the sidebar list adds around upstream's: run headers before
 * a run's first thread, a coordinator's children after its row, and headers
 * of runs folded away at the end of a section. Built once per list render;
 * `beforeMarker` and `atEnd` flush the active section's trailing headers once.
 */
export function forkSidebarList(input: {
  activeRuns: SidebarProjectRuns;
  settledRuns: SidebarProjectRuns;
  childThreadGroups: ChildThreadGroups;
  crossProjectRunKeys: ReadonlyMap<string, string>;
  projectGroupByThreadProjectKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  threadByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  routeThreadKey: string | null;
  onRunHeaderNewThread: (project: SidebarProjectSnapshot) => void;
}) {
  const runsFor = (section: SidebarSection) =>
    section === "active" ? input.activeRuns : section === "settled" ? input.settledRuns : null;

  const runHeaders = (section: RunSection, headers: readonly SidebarProjectRunHeaderInfo[]) => {
    const runs = runsFor(section)!;
    return headers.map((header) => (
      <SidebarProjectRunHeader
        key={`run-header:${section}:${header.projectKey}`}
        header={header}
        project={runs.projectByRunKey.get(header.projectKey) ?? null}
        onToggle={runs.toggleRun}
        onNewThread={input.onRunHeaderNewThread}
      />
    ));
  };

  // Runs folded away at the end of the active section have no row left to
  // hang their header on.
  let activeTrailingFlushed = false;
  const flushActiveTrailingHeaders = (): ReactNode[] => {
    if (activeTrailingFlushed) return [];
    activeTrailingFlushed = true;
    return runHeaders("active", input.activeRuns.plan.trailingHeaders);
  };

  return {
    /** Props for a thread row: its place in a run and whether it spans projects. */
    rowProps: (threadKey: string, section: SidebarSection) => ({
      crossProjectCoordinator: input.crossProjectRunKeys.has(threadKey),
      projectRunPlacement: runsFor(section)?.plan.placementByThreadKey.get(threadKey) ?? null,
    }),
    beforeThread: (threadKey: string, section: SidebarSection): ReactNode[] =>
      section === "active" || section === "settled"
        ? runHeaders(section, runsFor(section)!.plan.headersBeforeThreadKey.get(threadKey) ?? [])
        : [],
    /** The threads this one coordinates, under its row. */
    afterThread: (
      threadKey: string,
      section: SidebarSection,
      renderRow: (thread: EnvironmentThreadShell) => ReactNode,
    ): ReactNode => {
      const childThreads = input.childThreadGroups.childrenByParentKey.get(threadKey);
      if (!childThreads) return null;
      // A folded run keeps the open coordinator visible; its children fold with the run.
      const coordinator = input.threadByKey.get(threadKey)!;
      const runs = runsFor(section);
      const runKey =
        input.crossProjectRunKeys.get(threadKey) ??
        input.projectGroupByThreadProjectKey.get(
          `${coordinator.environmentId}:${coordinator.projectId}`,
        )?.projectKey;
      const runFolded =
        runs !== null &&
        runKey !== undefined &&
        runs.plan.runs.some((run) => run.projectKey === runKey && run.collapsed);
      return (
        <SidebarChildThreads
          key={`child-threads:${threadKey}`}
          parentKey={threadKey}
          children={childThreads}
          openThreadKey={input.routeThreadKey}
          {...(runFolded && runs && runKey ? { onUnfoldRun: () => runs.toggleRun(runKey) } : {})}
          renderRow={renderRow}
        />
      );
    },
    beforeMarker: (marker: string): ReactNode[] =>
      marker === "snoozed-header" || marker === "settled-header"
        ? flushActiveTrailingHeaders()
        : [],
    atEnd: (): ReactNode[] => [
      ...flushActiveTrailingHeaders(),
      ...runHeaders("settled", input.settledRuns.plan.trailingHeaders),
    ],
  };
}
