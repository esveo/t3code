import { create } from "zustand";

import changelogMarkdown from "../../../../../docs/fork/changelog.md?raw";
import {
  collectForkChangelogCommits,
  findNewForkChangelogEntries,
  parseForkChangelog,
  type ForkChangelogEntry,
} from "./forkChangelog.logic";

/** The changelog this build ships, parsed once. */
export const FORK_CHANGELOG_ENTRIES = parseForkChangelog(changelogMarkdown);

const SEEN_STORAGE_KEY = "t3code:fork-changelog-seen:v1";

/** The commits this client has shown, or null before its first start. */
function readSeenCommits(): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(SEEN_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : null;
  } catch {
    return null;
  }
}

/** Adds this build's commits to the record, keeping those of builds switched away from. */
function markAllSeen(): void {
  try {
    const seen = readSeenCommits() ?? new Set<string>();
    for (const commit of collectForkChangelogCommits(FORK_CHANGELOG_ENTRIES)) seen.add(commit);
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // Without storage the dialog would show on every start; there is nothing better to do.
  }
}

interface ForkChangelogStoreState {
  /** "new" after an update, "all" from the command palette. */
  view: "new" | "all" | null;
  newEntries: ReadonlyArray<ForkChangelogEntry>;
  /** Called once per start: shows what arrived since the last start, if anything. */
  showNewSinceLastStart: () => void;
  showAll: () => void;
  close: () => void;
}

export const useForkChangelogStore = create<ForkChangelogStoreState>()((set) => ({
  view: null,
  newEntries: [],
  showNewSinceLastStart: () => {
    const newEntries = findNewForkChangelogEntries(FORK_CHANGELOG_ENTRIES, readSeenCommits());
    if (newEntries.length === 0) {
      markAllSeen();
      return;
    }
    set({ view: "new", newEntries });
  },
  showAll: () => set({ view: "all" }),
  close: () => {
    markAllSeen();
    set({ view: null, newEntries: [] });
  },
}));
