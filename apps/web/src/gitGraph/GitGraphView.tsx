import type { EnvironmentId, VcsCommitGraphEntry, VcsCommitGraphRef } from "@t3tools/contracts";
import { GitBranchIcon, GitCommitHorizontalIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { gitGraphEnvironment } from "~/state/gitGraph";

import { layoutCommitGraph, type CommitGraphEdge } from "./commitGraphLayout";
import { GitGraphCommitDetails } from "./GitGraphCommitDetails";

const ROW_HEIGHT = 28;
const LANE_WIDTH = 14;
const LANE_PADDING = 10;
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

/**
 * Child lane -> carrier lane -> parent lane, bending once at each change. A
 * merge parent bends late (just above its parent) and a branch tip bends early,
 * which is what makes a merge read as joining rather than crossing.
 */
function edgePath(edge: CommitGraphEdge): string {
  const x = (lane: number) => LANE_PADDING + lane * LANE_WIDTH;
  const y = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;
  const startX = x(edge.startLane);
  const startY = y(edge.startRow);
  const carrierX = x(edge.lane);
  const endX = x(edge.endLane);
  const endY = edge.open ? edge.endRow * ROW_HEIGHT : y(edge.endRow);

  let path = `M${startX} ${startY}`;
  if (carrierX !== startX) {
    path +=
      ` L${startX} ${startY + ROW_HEIGHT * 0.3}` +
      ` C${startX} ${startY + ROW_HEIGHT * 0.75} ${carrierX} ${startY + ROW_HEIGHT * 0.5}` +
      ` ${carrierX} ${startY + ROW_HEIGHT}`;
  }
  const straightUntil = endX === carrierX ? endY : endY - ROW_HEIGHT;
  path += ` L${carrierX} ${Math.max(straightUntil, startY)}`;
  if (endX !== carrierX) {
    path += ` C${carrierX} ${endY - ROW_HEIGHT * 0.45} ${endX} ${endY - ROW_HEIGHT * 0.7} ${endX} ${endY}`;
  }
  return path;
}

const REF_BADGE_CLASS: Record<VcsCommitGraphRef["kind"], string> = {
  head: "border-primary/50 bg-primary/10 text-primary",
  branch: "border-border bg-muted text-foreground/80",
  remote: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  tag: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  other: "border-border bg-muted/60 text-muted-foreground",
};

export function GitGraphView({
  environmentId,
  cwd,
  title,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const graph = useEnvironmentQuery(
    gitGraphEnvironment.commitGraph({ environmentId, input: { cwd, limit } }),
  );

  const commits: ReadonlyArray<VcsCommitGraphEntry> = graph.data?.commits ?? [];
  const layout = useMemo(
    () => layoutCommitGraph(commits, { colorCount: LANE_HUES.length }),
    [commits],
  );
  const selected =
    selectedSha === null ? null : (commits.find((entry) => entry.sha === selectedSha) ?? null);
  const graphWidth = LANE_PADDING * 2 + Math.max(1, layout.laneCount) * LANE_WIDTH;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Git Graph</span>
        <span className="truncate text-xs text-muted-foreground">{title}</span>
        {graph.data?.currentRefName ? (
          <span className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground">
            <GitBranchIcon className="size-3 opacity-70" />
            <span className="max-w-60 truncate text-foreground">{graph.data.currentRefName}</span>
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {graph.isPending ? <Spinner className="size-4" /> : null}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Git Graph">
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
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
                    opacity={edge.open ? 0.3 : 0.9}
                    {...(edge.open ? { strokeDasharray: "3 4" } : {})}
                  />
                ))}
                {layout.rows.map((row) => {
                  const cx = LANE_PADDING + row.lane * LANE_WIDTH;
                  const cy = row.row * ROW_HEIGHT + ROW_HEIGHT / 2;
                  return row.isMerge ? (
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
                      onClick={() => setSelectedSha(row.commit.sha)}
                      style={{ height: ROW_HEIGHT, paddingLeft: graphWidth }}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md pr-2 text-left text-sm",
                        "hover:bg-accent/40",
                        row.commit.sha === selectedSha && "bg-accent",
                      )}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        {row.commit.refs.map((ref) => (
                          <span
                            key={`${ref.kind}:${ref.name}`}
                            className={cn(
                              "shrink-0 rounded-full border px-1.5 text-[11px] leading-4",
                              REF_BADGE_CLASS[ref.kind],
                            )}
                          >
                            {ref.kind === "head" ? `⌂ ${ref.name}` : ref.name}
                          </span>
                        ))}
                        <span className="truncate">{row.commit.subject}</span>
                      </span>
                      <span className="w-36 shrink-0 truncate text-xs text-muted-foreground">
                        {row.commit.author}
                      </span>
                      <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
                        {relativeTime(row.commit.authoredAt)}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground/70">
                        {row.commit.sha.slice(0, 8)}
                      </span>
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

        {selected ? (
          <GitGraphCommitDetails commit={selected} onClose={() => setSelectedSha(null)} />
        ) : null}
      </div>
    </div>
  );
}
