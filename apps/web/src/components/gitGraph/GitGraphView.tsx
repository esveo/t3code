import type { EnvironmentId, VcsCommitGraphEntry, VcsCommitGraphRef } from "@t3tools/contracts";
import { GitBranchIcon, GitCommitHorizontalIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { gitGraphEnvironment } from "~/state/gitGraph";
import { vcsEnvironment } from "~/state/vcs";

import { layoutCommitGraph } from "./commitGraphLayout";
import { edgePath, LANE_PADDING, LANE_WIDTH, ROW_HEIGHT } from "./edgePath";
import { GitGraphDiff } from "./GitGraphDiff";
import {
  GIT_GRAPH_FRESH_MS,
  gitGraphRefreshDelay,
  gitGraphStatusKey,
} from "./gitGraphRefresh.logic";
import { gitGraphDiffRange, nextGitGraphSelection, WORKTREE_ID } from "./gitGraphSelection";

const DOT_RADIUS = 3.5;
const INITIAL_LIMIT = 200;
const LIMIT_STEP = 300;
const MAX_LIMIT = 1000;

/**
 * Lane colours. One lightness and chroma across eight hues, so the lanes stay
 * distinguishable from each other and legible on light and dark themes alike
 * without a per-theme palette.
 */
const LANE_HUES = [285, 245, 200, 160, 120, 60, 30, 340];
const laneColor = (index: number) => `oklch(0.68 0.16 ${LANE_HUES[index % LANE_HUES.length]})`;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  return weeks < 9 ? `${weeks}w` : `${Math.round(days / 30)}mo`;
}

const REF_BADGE_CLASS: Record<VcsCommitGraphRef["kind"], string> = {
  head: "border-primary/50 bg-primary/10 text-primary",
  branch: "border-border bg-muted text-foreground/80",
  remote: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  tag: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  other: "border-border bg-muted/60 text-muted-foreground",
};

/**
 * `page` owns the whole window and titles itself; `embedded` sits in the right
 * panel, whose tab bar already carries the name and the close button.
 */
export type GitGraphViewMode = "page" | "embedded";

export function GitGraphView({
  environmentId,
  cwd,
  title,
  mode = "page",
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly title: string;
  readonly mode?: GitGraphViewMode;
  readonly onClose?: (() => void) | undefined;
}) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [selection, setSelection] = useState<ReadonlyArray<string>>([]);
  const graph = useEnvironmentQuery(
    gitGraphEnvironment.commitGraph({ environmentId, input: { cwd, limit } }),
  );
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const workingTree = status.data?.workingTree;
  const headSha = graph.data?.headSha ?? null;
  // The graph is read once and then kept for a while, so a reopened panel
  // would show the old commits. The live status says when to read again.
  const statusKey = gitGraphStatusKey(status.data);
  const { refresh: refreshGraph, isPending: graphPending, dataUpdatedAt: graphUpdatedAt } = graph;
  // The status the last read saw; null until this panel has read once.
  const readStatusKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (graphPending) return;
    const now = Date.now();
    if (
      readStatusKeyRef.current === null &&
      graphUpdatedAt !== null &&
      now - graphUpdatedAt < GIT_GRAPH_FRESH_MS
    ) {
      // A read that just landed saw the status beside it; a cached one from
      // an earlier visit falls through and is read again.
      readStatusKeyRef.current = statusKey;
      return;
    }
    const delay = gitGraphRefreshDelay({
      statusKey,
      readKey: readStatusKeyRef.current,
      dataUpdatedAt: graphUpdatedAt,
      now,
    });
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      readStatusKeyRef.current = statusKey;
      refreshGraph();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [graphPending, graphUpdatedAt, refreshGraph, statusKey]);
  const showWorktree = status.data?.hasWorkingTreeChanges === true && headSha !== null;

  // Uncommitted changes ride on top of HEAD as a commit of their own, so the
  // layout gives them a lane and an edge like any other child.
  const loadedCommits = graph.data?.commits;
  const commits = useMemo<ReadonlyArray<VcsCommitGraphEntry>>(() => {
    const loaded = loadedCommits ?? [];
    if (!showWorktree || headSha === null) return loaded;
    return [
      {
        sha: WORKTREE_ID,
        parents: [headSha],
        refs: [],
        author: "",
        authoredAt: "",
        subject: "Untracked changes",
      },
      ...loaded,
    ];
  }, [headSha, loadedCommits, showWorktree]);
  const layout = useMemo(
    () => layoutCommitGraph(commits, { colorCount: LANE_HUES.length }),
    [commits],
  );
  const range = useMemo(() => gitGraphDiffRange(selection, commits), [commits, selection]);
  const selectedPoints = useMemo(
    () => commits.filter((commit) => selection.includes(commit.sha)),
    [commits, selection],
  );
  const graphWidth = LANE_PADDING * 2 + Math.max(1, layout.laneCount) * LANE_WIDTH;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        className={cn(
          "flex shrink-0 items-center gap-3 border-b px-4",
          mode === "embedded" ? "py-1.5" : "py-2.5",
        )}
      >
        {mode === "page" ? (
          <>
            <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Git Graph</span>
          </>
        ) : null}
        <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>
        {(status.data?.refName ?? graph.data?.currentRefName) ? (
          <span className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0 opacity-70" />
            <span className="max-w-60 truncate text-foreground">
              {status.data?.refName ?? graph.data?.currentRefName}
            </span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {graph.isPending ? <Spinner className="size-4" /> : null}
          {onClose ? (
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Git Graph">
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>

      {/* Two nested containers: the outer one decides whether the details sit
          beside the graph or under it, the inner one how much of each commit
          row fits once that split is made. */}
      <div className="@container/gitgraph flex min-h-0 flex-1 flex-col @2xl/gitgraph:flex-row">
        <div
          className={cn(
            "@container/gitgraphrow min-h-0 min-w-0 flex-1 overflow-auto",
            range && "flex-[2]",
          )}
        >
          {graph.error !== null ? (
            <p className="p-6 text-sm text-destructive">{graph.error}</p>
          ) : graph.data?.isRepo === false ? (
            <p className="p-6 text-sm text-muted-foreground">
              This workspace is not a Git repository.
            </p>
          ) : commits.length === 0 && !graph.isPending ? (
            <p className="p-6 text-sm text-muted-foreground">This repository has no commits yet.</p>
          ) : (
            <div className="relative px-4 py-1">
              <svg
                aria-hidden
                className="pointer-events-none absolute top-1 left-4"
                width={graphWidth}
                height={commits.length * ROW_HEIGHT}
              >
                {layout.edges.map((edge) => (
                  <path
                    key={`${edge.from}-${edge.to ?? "open"}-${edge.lane}`}
                    d={edgePath(edge)}
                    fill="none"
                    stroke={laneColor(edge.color)}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    opacity={edge.open || edge.from === WORKTREE_ID ? 0.3 : 0.9}
                    {...(edge.open || edge.from === WORKTREE_ID ? { strokeDasharray: "3 4" } : {})}
                  />
                ))}
                {layout.rows.map((row) => {
                  const cx = LANE_PADDING + row.lane * LANE_WIDTH;
                  const cy = row.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                  return row.commit.sha === WORKTREE_ID ? (
                    <circle
                      key={row.commit.sha}
                      cx={cx}
                      cy={cy}
                      r={DOT_RADIUS + 0.5}
                      fill="var(--background)"
                      stroke={laneColor(row.color)}
                      strokeWidth={1.5}
                      strokeDasharray="2 2"
                    />
                  ) : row.isMerge ? (
                    <circle
                      key={row.commit.sha}
                      cx={cx}
                      cy={cy}
                      r={DOT_RADIUS + 0.5}
                      fill="var(--background)"
                      stroke={laneColor(row.color)}
                      strokeWidth={2}
                    />
                  ) : (
                    <circle
                      key={row.commit.sha}
                      cx={cx}
                      cy={cy}
                      r={DOT_RADIUS}
                      fill={laneColor(row.color)}
                    />
                  );
                })}
              </svg>

              <ul className="relative">
                {layout.rows.map((row) => (
                  <li key={row.commit.sha}>
                    <button
                      type="button"
                      onClick={(event) =>
                        setSelection((current) =>
                          nextGitGraphSelection(
                            current,
                            row.commit.sha,
                            event.metaKey || event.ctrlKey,
                          ),
                        )
                      }
                      style={{ height: ROW_HEIGHT, paddingLeft: graphWidth }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md pr-2 text-left text-sm",
                        "hover:bg-accent/40",
                        selection.includes(row.commit.sha) && "bg-accent",
                      )}
                    >
                      {row.commit.sha === WORKTREE_ID ? (
                        <>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground italic">
                            Untracked changes
                          </span>
                          {workingTree ? (
                            <DiffStatLabel
                              additions={workingTree.insertions}
                              deletions={workingTree.deletions}
                              layout="inline"
                              className="shrink-0 text-xs"
                            />
                          ) : null}
                        </>
                      ) : (
                        <>
                          {/* Badges shrink and truncate instead of spilling into
                          the author column when a commit carries long refs;
                          hovering one grows it back to its full name. */}
                          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                            {row.commit.refs.map((ref) => (
                              <span
                                key={`${ref.kind}:${ref.name}`}
                                className={cn(
                                  "min-w-6 max-w-56 truncate rounded-full border px-1.5 text-[11px] leading-4 hover:max-w-none hover:shrink-0",
                                  REF_BADGE_CLASS[ref.kind],
                                )}
                              >
                                {ref.kind === "head" ? `⌂ ${ref.name}` : ref.name}
                              </span>
                            ))}
                            <span className="min-w-16 truncate">{row.commit.subject}</span>
                          </span>
                          {/* Narrow panes keep the subject and the date and drop
                          the rest; the details pane still has all of it. */}
                          <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground @xl/gitgraphrow:block">
                            {row.commit.author}
                          </span>
                          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
                            {relativeTime(row.commit.authoredAt)}
                          </span>
                          <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground/70 @lg/gitgraphrow:block">
                            {row.commit.sha.slice(0, 8)}
                          </span>
                        </>
                      )}
                    </button>
                  </li>
                ))}
              </ul>

              {graph.data?.hasMore === true ? (
                <div className="flex justify-center py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={limit >= MAX_LIMIT || graph.isPending}
                    onClick={() => setLimit((current) => Math.min(MAX_LIMIT, current + LIMIT_STEP))}
                  >
                    {limit >= MAX_LIMIT ? `Showing the newest ${MAX_LIMIT} commits` : "Load more"}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {range ? (
          <GitGraphDiff
            key={JSON.stringify(range)}
            environmentId={environmentId}
            cwd={cwd}
            range={range}
            points={selectedPoints}
            refreshKey={JSON.stringify(workingTree ?? null)}
            onClose={() => setSelection([])}
          />
        ) : null}
      </div>
    </div>
  );
}
