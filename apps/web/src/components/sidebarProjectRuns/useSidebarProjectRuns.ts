import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useCallback, useMemo } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useGroupSidebarThreadsByProject } from "../../hooks/useSettings";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { buildSidebarProjectRunPlan, type SidebarProjectRunPlan } from "./sidebarProjectRuns.logic";

const COLLAPSED_RUNS_KEY = "sidebar-project-runs-collapsed";
const NO_COLLAPSED_RUNS: readonly string[] = [];
const collapsedRunsSchema = Schema.Array(Schema.String);

/**
 * Collapsed runs, remembered per section so folding a project away in the
 * settled shelf does not also fold it in the active list.
 */
function useCollapsedRuns() {
  const [collapsedRuns, setCollapsedRuns] = useLocalStorage(
    COLLAPSED_RUNS_KEY,
    NO_COLLAPSED_RUNS,
    collapsedRunsSchema,
  );
  const collapsed = useMemo(() => new Set(collapsedRuns), [collapsedRuns]);
  const toggle = useCallback(
    (runKey: string) =>
      setCollapsedRuns((keys) =>
        keys.includes(runKey) ? keys.filter((key) => key !== runKey) : [...keys, runKey],
      ),
    [setCollapsedRuns],
  );
  return { collapsed, toggle };
}

export interface SidebarProjectRuns {
  readonly plan: SidebarProjectRunPlan<EnvironmentThreadShell>;
  readonly projectByRunKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  readonly toggleRun: (projectKey: string) => void;
}

/**
 * Fork: gathers one sidebar section's threads into per-project runs when
 * Settings → Appearance asks for it. The section keeps its own sort; the
 * plan only decides which rows sit next to each other, which run headers
 * appear, and which rows draw a rail.
 */
export function useSidebarProjectRuns(input: {
  section: "active" | "settled";
  threads: readonly EnvironmentThreadShell[];
  /** Logical project group per `${environmentId}:${projectId}` thread key. */
  projectGroupByThreadProjectKey: ReadonlyMap<string, SidebarProjectSnapshot>;
  /** The open thread, which a collapsed run must not hide. */
  routeThreadKey: string | null;
  /** Fork (thread orchestration): threads that join another run than their project's. */
  runKeyByThreadKey?: ReadonlyMap<string, string>;
}): SidebarProjectRuns {
  const enabled = useGroupSidebarThreadsByProject();
  const { collapsed, toggle } = useCollapsedRuns();
  const { section, threads, projectGroupByThreadProjectKey, routeThreadKey, runKeyByThreadKey } =
    input;

  const projectByRunKey = useMemo(() => {
    const groups = new Map<string, SidebarProjectSnapshot>();
    for (const group of projectGroupByThreadProjectKey.values()) {
      groups.set(group.projectKey, group);
    }
    return groups;
  }, [projectGroupByThreadProjectKey]);

  const plan = useMemo(
    () =>
      buildSidebarProjectRunPlan({
        threads: enabled ? threads : [],
        threadKeyOf: (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        projectKeyOf: (thread) =>
          runKeyByThreadKey?.get(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ) ??
          projectGroupByThreadProjectKey.get(`${thread.environmentId}:${thread.projectId}`)
            ?.projectKey ??
          null,
        isCollapsed: (projectKey) => collapsed.has(`${section}:${projectKey}`),
        isRunning: (thread) =>
          thread.session?.status === "running" && thread.session.activeTurnId != null,
        // The states that wait on a person rather than on the agent.
        needsAttention: (thread) => {
          const status = resolveSidebarThreadStatus(thread);
          return status === "input" || status === "approval" || status === "failed";
        },
        isProtected: (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
      }),
    [
      collapsed,
      enabled,
      projectGroupByThreadProjectKey,
      routeThreadKey,
      runKeyByThreadKey,
      section,
      threads,
    ],
  );

  const toggleRun = useCallback(
    (projectKey: string) => toggle(`${section}:${projectKey}`),
    [section, toggle],
  );

  // Disabled, the section renders exactly as it did: the same array instance,
  // so nothing downstream sees a new identity on every settings read.
  return enabled
    ? { plan, projectByRunKey, toggleRun }
    : { plan: { ...plan, threads }, projectByRunKey, toggleRun };
}
