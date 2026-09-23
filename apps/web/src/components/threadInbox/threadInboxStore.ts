import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";
import type { DecisionDraft, InboxGroupBy } from "./threadInbox.logic";

/**
 * Fork: the Inbox tab's drafts and view, per coordinator (its scoped thread
 * key). Drafts are persisted: a half-answered inbox survives a reload or an
 * app update, and only leaves when it is sent.
 */
export interface InboxView {
  readonly mode: "list" | "focus";
  readonly groupBy: InboxGroupBy;
  /** The decision open in the list or shown in focus. */
  readonly currentId: string | null;
  /** False when the user folded the current row in the list. */
  readonly expanded: boolean;
}

export const DEFAULT_INBOX_VIEW: InboxView = {
  mode: "list",
  groupBy: "urgency",
  currentId: null,
  expanded: true,
};

const EMPTY_DRAFTS: Readonly<Record<string, DecisionDraft>> = {};

interface ThreadInboxStoreState {
  drafts: Readonly<Record<string, Readonly<Record<string, DecisionDraft>>>>;
  views: Readonly<Record<string, InboxView>>;
  /** Merges into the draft; null removes it. */
  setDraft: (key: string, decisionId: string, patch: Partial<DecisionDraft> | null) => void;
  clearDrafts: (key: string, decisionIds: ReadonlyArray<string>) => void;
  setView: (key: string, patch: Partial<InboxView>) => void;
}

export const useThreadInboxStore = create<ThreadInboxStoreState>()(
  persist(
    (set) => ({
      drafts: {},
      views: {},
      setDraft: (key, decisionId, patch) =>
        set((state) => {
          const current = { ...state.drafts[key] };
          if (patch === null) delete current[decisionId];
          else current[decisionId] = { ...current[decisionId], ...patch };
          return { drafts: { ...state.drafts, [key]: current } };
        }),
      clearDrafts: (key, decisionIds) =>
        set((state) => {
          const current = { ...state.drafts[key] };
          for (const id of decisionIds) delete current[id];
          return { drafts: { ...state.drafts, [key]: current } };
        }),
      setView: (key, patch) =>
        set((state) => ({
          views: {
            ...state.views,
            [key]: { ...DEFAULT_INBOX_VIEW, ...state.views[key], ...patch },
          },
        })),
    }),
    {
      name: "t3code:thread-inbox:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ drafts: state.drafts, views: state.views }),
    },
  ),
);

export function useInboxDrafts(key: string): Readonly<Record<string, DecisionDraft>> {
  return useThreadInboxStore((state) => state.drafts[key] ?? EMPTY_DRAFTS);
}

export function useInboxView(key: string): InboxView {
  return useThreadInboxStore((state) => state.views[key] ?? DEFAULT_INBOX_VIEW);
}
