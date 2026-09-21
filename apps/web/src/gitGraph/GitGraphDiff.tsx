import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewDiffRange, VcsCommitGraphEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DiffStatLabel } from "~/components/chat/DiffStatLabel";
import { DiffPanelLoadingState } from "~/components/DiffPanelShell";
import { DiffFileLoadingBoundary } from "~/components/diffs/DiffFileLoadingBoundary";
import { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";
import { useReviewFilePatches } from "~/components/diffs/useReviewFilePatches";
import { Button } from "~/components/ui/button";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { createGitDiffFileContentsLoader } from "~/lib/diffFileContents";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  fnv1a32,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, isMacPlatform } from "~/lib/utils";
import { reviewEnvironment } from "~/state/review";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { WORKTREE_ID } from "./gitGraphSelection";

const COMPARE_HINT = `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click another row to compare`;

function PointLabel({ point }: { readonly point: VcsCommitGraphEntry }) {
  return point.sha === WORKTREE_ID ? (
    <span className="truncate italic">Untracked changes</span>
  ) : (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {point.sha.slice(0, 8)}
      </span>
      <span className="truncate">{point.subject}</span>
    </span>
  );
}

/**
 * The diff of what is selected in the graph: one commit against its first
 * parent, the working tree against HEAD, or two points against each other.
 * `points` are newest first; `refreshKey` changes whenever the working tree
 * does, so a diff that ends in it stays current.
 */
export function GitGraphDiff({
  environmentId,
  cwd,
  range,
  points,
  refreshKey,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly range: ReviewDiffRange;
  readonly points: ReadonlyArray<VcsCommitGraphEntry>;
  readonly refreshKey: string;
  readonly onClose: () => void;
}) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const preview = useEnvironmentQuery(
    reviewEnvironment.diffPreview({
      environmentId,
      input: { cwd, range, ignoreWhitespace: settings.diffIgnoreWhitespace },
    }),
  );
  const source = preview.data?.sources.find((candidate) => candidate.kind === "commit-range");

  const refresh = preview.refresh;
  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (range.head !== null || lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    refresh();
  }, [range.head, refresh, refreshKey]);

  const lazySource = source?.truncated && source.files ? source : null;
  const renderablePatch = useMemo(
    () =>
      lazySource
        ? null
        : getRenderablePatch(source?.diff, `git-graph:${resolvedTheme}`, {
            compactPartialHunkOffsets: true,
          }),
    [lazySource, resolvedTheme, source?.diff],
  );
  const { renderableFiles, readyFilePaths, settledFileCount, loadNextFiles } = useReviewFilePatches(
    {
      environmentId,
      cwd: preview.data?.cwd,
      source: lazySource,
      baseRef: null,
      range,
      ignoreWhitespace: settings.diffIgnoreWhitespace,
      theme: resolvedTheme,
      revision: preview.data ? DateTime.formatIso(preview.data.generatedAt) : undefined,
      preview: renderablePatch,
    },
  );

  const loadDiffFiles = useMemo(
    () =>
      source && preview.data
        ? createGitDiffFileContentsLoader(getDiffFileContents, {
            environmentId,
            cwd: preview.data.cwd,
            sourceKind: "commit-range",
            baseRef: range.base,
            headRef: range.head,
            cacheKey: source.diffHash,
          })
        : undefined,
    [environmentId, getDiffFileContents, preview.data, range, source],
  );

  // Collapsing is local to this diff: the pane remounts per selection.
  const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const toggleCollapsed = useCallback((fileKey: string, collapsed: boolean) => {
    setCollapseOverrides((current) => new Map(current).set(fileKey, !collapsed));
  }, []);
  const items = useMemo<CodeViewDiffItem<undefined>[]>(
    () =>
      renderableFiles
        .filter((fileDiff) => !lazySource || readyFilePaths.has(resolveFileDiffPath(fileDiff)))
        .map((fileDiff) => {
          const id = buildFileDiffIdentityKey(fileDiff);
          const collapsed =
            fileDiff.cacheKey?.endsWith(":pending") === true ||
            (collapseOverrides.get(id) ?? settings.diffFilesCollapsed);
          return {
            id,
            type: "diff",
            fileDiff,
            collapsed,
            version: fnv1a32(`${buildFileDiffContentVersion(fileDiff)}:${collapsed ? 1 : 0}`),
          };
        }),
    [collapseOverrides, lazySource, readyFilePaths, renderableFiles, settings.diffFilesCollapsed],
  );
  const lineStat = useMemo(
    () =>
      source?.files
        ? source.files.reduce(
            (total, file) => ({
              additions: total.additions + file.additions,
              deletions: total.deletions + file.deletions,
            }),
            { additions: 0, deletions: 0 },
          )
        : getDiffLineStat(renderableFiles),
    [renderableFiles, source],
  );
  const renderLoadingBoundary = useCallback(
    () =>
      settledFileCount < renderableFiles.length ? (
        <DiffFileLoadingBoundary
          load={loadNextFiles}
          count={renderableFiles.length - settledFileCount}
        />
      ) : null,
    [loadNextFiles, renderableFiles.length, settledFileCount],
  );

  const single = points.length === 1 ? points[0] : undefined;
  const authored = single && single.sha !== WORKTREE_ID ? new Date(single.authoredAt) : null;
  const fileCount = source?.files?.length ?? renderableFiles.length;

  return (
    <section className="flex min-h-0 min-w-0 flex-[3] flex-col border-t @2xl/gitgraph:border-t-0 @2xl/gitgraph:border-l">
      <header className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
          {single ? (
            <>
              <span className="truncate font-semibold">
                {single.sha === WORKTREE_ID ? "Untracked changes" : single.subject}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {single.sha === WORKTREE_ID ? (
                  "Working tree against HEAD"
                ) : (
                  <>
                    <span className="font-mono">{single.sha.slice(0, 12)}</span>
                    {` · ${single.author}`}
                    {authored && !Number.isNaN(authored.getTime())
                      ? ` · ${authored.toLocaleString()}`
                      : null}
                  </>
                )}
              </span>
            </>
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              <PointLabel point={points[1]!} />
              <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <PointLabel point={points[0]!} />
            </span>
          )}
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {source ? (
              <>
                <span>{fileCount === 1 ? "1 file" : `${fileCount} files`}</span>
                <DiffStatLabel {...lineStat} layout="inline" />
              </>
            ) : null}
            {single ? (
              <span className="truncate text-muted-foreground/70">{COMPARE_HINT}</span>
            ) : null}
          </span>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close diff">
          <XIcon className="size-4" />
        </Button>
      </header>

      {preview.error !== null && !source ? (
        <p className="p-4 text-xs text-destructive">{preview.error}</p>
      ) : !source ? (
        preview.data ? (
          <p className="p-4 text-xs text-muted-foreground">
            Comparing commits needs an up-to-date server.
          </p>
        ) : (
          <DiffPanelLoadingState label="Loading diff..." />
        )
      ) : fileCount === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">No changes.</p>
      ) : renderablePatch?.kind === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <p className="mb-2 text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
          <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground/90">
            {renderablePatch.text}
          </pre>
        </div>
      ) : (
        <>
          {source.truncated && !lazySource ? (
            <p className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
              This diff exceeds the size limit. Changes shown are incomplete.
            </p>
          ) : null}
          <div
            className="min-h-0 flex-1"
            onClickCapture={(event) => {
              const composedPath = event.nativeEvent.composedPath?.() ?? [];
              if (composedPath.some((node) => node instanceof HTMLButtonElement)) return;
              const header = composedPath.find(
                (node): node is HTMLElement =>
                  node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
              );
              const filePath = header?.querySelector("[data-title]")?.textContent;
              const item = filePath
                ? items.find((candidate) => resolveFileDiffPath(candidate.fileDiff) === filePath)
                : undefined;
              if (item) toggleCollapsed(item.id, item.collapsed === true);
            }}
          >
            <StyledDiffCodeView<undefined>
              className="h-full min-h-0 overflow-auto"
              items={items}
              renderCodeViewFooter={renderLoadingBoundary}
              renderHeaderPrefix={(item) =>
                item.type === "diff" ? (
                  <CollapseButton
                    fileDiff={item.fileDiff}
                    collapsed={item.collapsed === true}
                    onToggle={() => toggleCollapsed(item.id, item.collapsed === true)}
                  />
                ) : null
              }
              options={{
                diffStyle: settings.diffLayout === "split" ? "split" : "unified",
                lineDiffType: "none",
                overflow: settings.wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                themeType: resolvedTheme,
                stickyHeaders: true,
                ...(loadDiffFiles ? { loadDiffFiles } : {}),
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}

function CollapseButton({
  fileDiff,
  collapsed,
  onToggle,
}: {
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const filePath = resolveFileDiffPath(fileDiff);
  return (
    <Button
      size="icon-micro"
      variant="ghost"
      className={cn(
        "-ms-0.5 [--control-icon-color:currentColor] bg-transparent hover:bg-foreground/10",
        getDiffCollapseIconClassName(fileDiff),
      )}
      aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
      aria-expanded={!collapsed}
      disabled={fileDiff.cacheKey?.endsWith(":pending") === true}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {collapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
    </Button>
  );
}
