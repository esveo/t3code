/**
 * Fork: project runs in the sidebar thread list.
 *
 * A run is one project's threads, kept next to each other in a section that
 * otherwise sorts purely by recency. The plan below is the whole model: it
 * reorders the section, says where a run header goes, and tells each row
 * which part of its run it is (so the row can draw the rail).
 *
 * Ordering rule: projects keep the position of their best-placed thread, and
 * threads keep their order inside a project. Nothing is re-sorted, only
 * gathered — the most recent thread still decides which project leads. The
 * one exception is a run waiting on the user: it leads the section, and its
 * waiting threads show even while the run is folded, because work that needs
 * an answer must not sit behind a fold or a scroll.
 */

export type SidebarProjectRunPlacement = "first" | "middle" | "last" | "only";

export interface SidebarProjectRunHeader {
  readonly projectKey: string;
  /** Threads in the run, including the ones a collapsed run hides. */
  readonly threadCount: number;
  readonly runningCount: number;
  /** Threads waiting on the user: pending input, an approval, or a failure. */
  readonly attentionCount: number;
  readonly collapsed: boolean;
}

export interface SidebarProjectRunPlan<TThread> {
  /** The section's threads, gathered into runs; collapsed runs drop theirs. */
  readonly threads: readonly TThread[];
  /** Every run in rendered order, whether or not it has a visible row. */
  readonly runs: readonly SidebarProjectRunHeader[];
  /** Headers to render directly above the keyed row. */
  readonly headersBeforeThreadKey: ReadonlyMap<string, readonly SidebarProjectRunHeader[]>;
  /** Headers of collapsed runs with no visible row left below them. */
  readonly trailingHeaders: readonly SidebarProjectRunHeader[];
  readonly placementByThreadKey: ReadonlyMap<string, SidebarProjectRunPlacement>;
}

const NO_HEADERS: readonly SidebarProjectRunHeader[] = [];

function plainPlan<TThread>(threads: readonly TThread[]): SidebarProjectRunPlan<TThread> {
  return {
    threads,
    runs: NO_HEADERS,
    headersBeforeThreadKey: new Map(),
    trailingHeaders: NO_HEADERS,
    placementByThreadKey: new Map(),
  };
}

function placementAt(index: number, length: number): SidebarProjectRunPlacement {
  if (length === 1) return "only";
  if (index === 0) return "first";
  return index === length - 1 ? "last" : "middle";
}

export function buildSidebarProjectRunPlan<TThread>(input: {
  readonly threads: readonly TThread[];
  readonly threadKeyOf: (thread: TThread) => string;
  readonly projectKeyOf: (thread: TThread) => string | null;
  readonly isCollapsed: (projectKey: string) => boolean;
  readonly isRunning: (thread: TThread) => boolean;
  /** Waiting on the user: such a run leads the section and shows through a fold. */
  readonly needsAttention: (thread: TThread) => boolean;
  /** Stays visible inside a collapsed run — the thread the user has open. */
  readonly isProtected: (thread: TThread) => boolean;
}): SidebarProjectRunPlan<TThread> {
  const grouped = new Map<string, TThread[]>();
  for (const thread of input.threads) {
    // A thread whose project has not loaded yet gets a run of its own rather
    // than joining a shared "unknown" pile that would reshuffle on load.
    const projectKey = input.projectKeyOf(thread) ?? `\u0000${input.threadKeyOf(thread)}`;
    const run = grouped.get(projectKey);
    if (run === undefined) grouped.set(projectKey, [thread]);
    else run.push(thread);
  }
  // One project, or none with more than a single thread: gathering changes
  // nothing and headers would only add chrome to a list that reads fine.
  if (grouped.size < 2 || ![...grouped.values()].some((run) => run.length > 1)) {
    return plainPlan(input.threads);
  }

  const runs = [...grouped].map(([projectKey, threads]) => ({
    projectKey,
    threads,
    attentionCount: threads.filter(input.needsAttention).length,
  }));
  // Stable within each half: a run only ever jumps the queue by waiting on
  // the user, and the rest of the section keeps its recency order.
  const ordered = [
    ...runs.filter((run) => run.attentionCount > 0),
    ...runs.filter((run) => run.attentionCount === 0),
  ];

  const threads: TThread[] = [];
  const headers: SidebarProjectRunHeader[] = [];
  const headersBeforeThreadKey = new Map<string, SidebarProjectRunHeader[]>();
  const placementByThreadKey = new Map<string, SidebarProjectRunPlacement>();
  let pendingHeaders: SidebarProjectRunHeader[] = [];
  for (const run of ordered) {
    const collapsed = input.isCollapsed(run.projectKey);
    // A fold hides finished work, never work that is waiting on an answer:
    // a folded run still shows the threads asking for one (and the open
    // thread), and hides them again by itself once they are answered.
    const visible = collapsed
      ? run.threads.filter((thread) => input.isProtected(thread) || input.needsAttention(thread))
      : run.threads;
    const header: SidebarProjectRunHeader = {
      projectKey: run.projectKey,
      threadCount: run.threads.length,
      runningCount: run.threads.filter(input.isRunning).length,
      attentionCount: run.attentionCount,
      collapsed,
    };
    headers.push(header);
    pendingHeaders.push(header);
    const head = visible[0];
    if (head === undefined) continue;
    headersBeforeThreadKey.set(input.threadKeyOf(head), pendingHeaders);
    pendingHeaders = [];
    for (const [index, thread] of visible.entries()) {
      threads.push(thread);
      placementByThreadKey.set(input.threadKeyOf(thread), placementAt(index, visible.length));
    }
  }

  return {
    threads,
    runs: headers,
    headersBeforeThreadKey,
    trailingHeaders: pendingHeaders,
    placementByThreadKey,
  };
}
