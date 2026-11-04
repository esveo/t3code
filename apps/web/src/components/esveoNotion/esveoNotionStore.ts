import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  EsveoNotionPageRef,
  EsveoNotionStatus,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { create } from "zustand";

import { type RightPanelSurface, rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";

interface TabHistory {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
}

/**
 * Fork: the Notion viewer's client state. Connection status per environment
 * (so a link click can decide synchronously), each tab's back/forward history,
 * and titles of pages seen in relations and breadcrumbs. Not persisted.
 */
interface EsveoNotionStoreState {
  statusByEnvironment: Readonly<Record<string, EsveoNotionStatus>>;
  historyByTab: Readonly<Record<string, TabHistory>>;
  refs: Readonly<Record<string, EsveoNotionPageRef>>;
  setStatus: (environmentId: EnvironmentId, status: EsveoNotionStatus) => void;
  setHistory: (tabKey: string, history: TabHistory) => void;
  addRefs: (environmentId: EnvironmentId, refs: ReadonlyArray<EsveoNotionPageRef>) => void;
}

export const useEsveoNotionStore = create<EsveoNotionStoreState>()((set) => ({
  statusByEnvironment: {},
  historyByTab: {},
  refs: {},
  setStatus: (environmentId, status) =>
    set((state) => ({
      statusByEnvironment: { ...state.statusByEnvironment, [environmentId]: status },
    })),
  setHistory: (tabKey, history) =>
    set((state) => ({ historyByTab: { ...state.historyByTab, [tabKey]: history } })),
  addRefs: (environmentId, refs) =>
    set((state) => ({
      refs: {
        ...state.refs,
        ...Object.fromEntries(refs.map((ref) => [refKey(environmentId, ref.id), ref])),
      },
    })),
}));

export const refKey = (environmentId: EnvironmentId, pageId: string) =>
  `${environmentId}:${pageId}`;

export const tabKey = (threadRef: ScopedThreadRef, surfaceId: string) =>
  `${scopedThreadKey(threadRef)}|${surfaceId}`;

/** The tab's history, or a fresh one when the tab moved to a page outside it. */
export function tabHistory(history: TabHistory | undefined, pageId: string): TabHistory {
  return history !== undefined && history.entries[history.index] === pageId
    ? history
    : { entries: [pageId], index: 0 };
}

type NotionSurface = Extract<RightPanelSurface, { kind: "notion" }>;

/** Moves a tab to another page (or titles it) without opening another tab. */
export function updateNotionSurface(
  threadRef: ScopedThreadRef,
  surfaceId: string,
  patch: Partial<Pick<NotionSurface, "pageId" | "title">>,
) {
  const key = scopedThreadKey(rightPanelHostRef(threadRef));
  useRightPanelStore.setState((state) => {
    const thread = state.byThreadKey[key];
    if (thread === undefined) return state;
    let changed = false;
    const surfaces = thread.surfaces.map((surface) => {
      if (surface.id !== surfaceId || surface.kind !== "notion") return surface;
      const next = { ...surface, ...patch };
      if (next.pageId === surface.pageId && next.title === surface.title) return surface;
      changed = true;
      return next;
    });
    return changed
      ? { byThreadKey: { ...state.byThreadKey, [key]: { ...thread, surfaces } } }
      : state;
  });
}

/** Activates a tab already showing the page, else opens a new one. */
export function openNotionPage(threadRef: ScopedThreadRef, pageId: string) {
  const panel = useRightPanelStore.getState();
  const host = scopedThreadKey(rightPanelHostRef(threadRef));
  const surfaces = panel.byThreadKey[host]?.surfaces ?? [];
  const showing = surfaces.find(
    (surface) => surface.kind === "notion" && surface.pageId === pageId,
  );
  if (showing !== undefined) {
    panel.activateSurface(threadRef, showing.id);
    return;
  }
  const taken = surfaces.some((surface) => surface.id === `notion:${pageId}`);
  panel.openNotion(threadRef, {
    id: taken ? `notion:${pageId}:${Date.now().toString(36)}` : `notion:${pageId}`,
    kind: "notion",
    pageId,
  });
}
