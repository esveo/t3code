import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { type CSSProperties, useEffect, useState } from "react";

import { resolveAssetUrl, useAssetUrlState } from "~/assets/assetUrls";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { environmentThreads, environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import {
  collectThreadImagesCached,
  gridWindow,
  mergeThreadImages,
  threadTreeIds,
  type ThreadImage,
} from "./threadImages.logic";

const MAX_CONCURRENT_HISTORY_LOADS = 3;
const PLACEHOLDER_ROWS_WHILE_LOADING = 2;
// ponytail: the preview pages through this many neighbours per side, as each needs its own URL.
const PREVIEW_NEIGHBOURS = 20;

const TILE_CLASS =
  "absolute flex items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/30";

// Subscribes to each thread only while this tab shows: closed threads have no items otherwise.
const threadTreeStatesAtom = Atom.family((key: string) => {
  const [environmentId, ...threadIds] = key.split("\n");
  return Atom.make((get): ReadonlyArray<EnvironmentThreadState> =>
    threadIds.map((id) =>
      Option.getOrElse(
        AsyncResult.value(
          get(environmentThreads.stateAtom(environmentId as EnvironmentId, id as ThreadId)),
        ),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ),
  );
});

/** Fork: the right panel's gallery of every image in a thread and the threads below it. */
export function ThreadImagesPanel(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | undefined;
}) {
  if (props.threadRef === null) return null;
  return <ThreadImagesGrid threadRef={props.threadRef} workspaceRoot={props.workspaceRoot} />;
}

function ThreadImagesGrid(props: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | undefined;
}) {
  const { environmentId, threadId } = props.threadRef;
  const shells = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const treeKey = threadTreeIds(threadId, shells).join("\n");
  const states = useAtomValue(threadTreeStatesAtom(`${environmentId}\n${treeKey}`));
  const treeIds = treeKey.split("\n") as ThreadId[];

  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load thread images history",
    reportFailure: false,
  });
  const loadingCount = states.filter((state) => state.history.loading).length;
  const pendingHistory = treeIds
    .filter((_, index) => {
      const history = states[index]?.history;
      return history?.hasMoreHistory && !history.loading && history.error === null;
    })
    .slice(0, Math.max(0, MAX_CONCURRENT_HISTORY_LOADS - loadingCount))
    .join("\n");
  // oxlint-disable-next-line t3code/react-effect-budget -- pages the server's history in until complete; each page re-triggers this.
  useEffect(() => {
    if (!pendingHistory) return;
    for (const id of pendingHistory.split("\n")) {
      void loadEarlier({ environmentId, input: { threadId: id as ThreadId } });
    }
  }, [environmentId, loadEarlier, pendingHistory]);

  const worktreeById = new Map(shells.map((shell) => [shell.id, shell.worktreePath]));
  const images = mergeThreadImages(
    states.map((state, index) => {
      const id = treeIds[index];
      if (id === undefined || Option.isNone(state.data)) return [];
      const root =
        id === threadId ? props.workspaceRoot : (worktreeById.get(id) ?? props.workspaceRoot);
      return collectThreadImagesCached(state.data.value, id, root);
    }),
  );
  const loading = states.some(
    (state) =>
      state.history.error === null &&
      (state.history.hasMoreHistory ||
        (Option.isNone(state.data) && state.status !== "deleted" && Option.isNone(state.error))),
  );

  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const observeViewport = (element: HTMLDivElement | null) => {
    if (element === null) return;
    return observeResize(element, () =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
  };

  const connection = usePreparedConnection(environmentId);
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const openPreview = async (index: number) => {
    const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
    const clicked = images[index];
    const neighbours = images.slice(
      Math.max(0, index - PREVIEW_NEIGHBOURS),
      index + PREVIEW_NEIGHBOURS + 1,
    );
    const resolved = await Promise.all(
      neighbours.map(async (image) => {
        if (image.source._tag === "direct") return image.source.src;
        if (httpBaseUrl === null) return null;
        const result = await createUrl({
          environmentId,
          input: { resource: image.source.resource },
        });
        return result._tag === "Failure"
          ? null
          : resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      }),
    );
    const available = neighbours.flatMap((image, position) => {
      const src = resolved[position];
      return src ? [{ image, src }] : [];
    });
    const previewIndex = available.findIndex(({ image }) => image === clicked);
    if (previewIndex < 0) return;
    openExpandedImagePreview(scopedThreadKey(props.threadRef), {
      images: available.map(({ image, src }) => ({ src, name: image.name })),
      index: previewIndex,
    });
  };

  const { columns } = gridWindow({ ...viewport, scrollTop: 0, count: 0 });
  const count = images.length + (loading ? columns * PLACEHOLDER_ROWS_WHILE_LOADING : 0);
  const grid = gridWindow({ ...viewport, scrollTop, count });
  const tiles = [];
  for (let index = grid.first; index < grid.last; index++) {
    const style = {
      top: Math.floor(index / grid.columns) * (grid.tileSize + grid.gap),
      left: (index % grid.columns) * (grid.tileSize + grid.gap),
      width: grid.tileSize,
      height: grid.tileSize,
    };
    const image = images[index];
    tiles.push(
      image ? (
        <ThreadImageTile
          key={image.key}
          environmentId={environmentId}
          image={image}
          style={style}
          onOpen={() => void openPreview(index)}
        />
      ) : (
        <div key={`placeholder:${index}`} className={TILE_CLASS} style={style}>
          <ImageIcon aria-hidden className="size-5 text-icon-muted opacity-40" />
        </div>
      ),
    );
  }

  return (
    <div
      ref={observeViewport}
      className="h-full overflow-y-auto"
      // Snapped to rows, so scrolling only re-renders when a row enters; overscan covers the rest.
      onScroll={(event) => {
        const rowHeight = grid.tileSize + grid.gap;
        setScrollTop(Math.floor(event.currentTarget.scrollTop / rowHeight) * rowHeight);
      }}
    >
      {count === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No images in this thread yet.</p>
      ) : (
        <div className="relative m-2" style={{ height: grid.totalHeight }}>
          {tiles}
        </div>
      )}
      {loading ? (
        <p className="sticky bottom-0 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground">
          Loading older images… {images.length} so far
        </p>
      ) : null}
    </div>
  );
}

function ThreadImageTile(props: {
  readonly environmentId: EnvironmentId;
  readonly image: ThreadImage;
  readonly style: CSSProperties;
  readonly onOpen: () => void;
}) {
  const { image } = props;
  const asset = useAssetUrlState(
    props.environmentId,
    image.source._tag === "asset" ? image.source.resource : null,
  );
  const src =
    image.source._tag === "direct" ? image.source.src : asset._tag === "Success" ? asset.url : null;
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const failed = status === "failed" || (image.source._tag === "asset" && asset._tag === "Failure");
  return (
    <button
      type="button"
      disabled={failed}
      aria-label={failed ? `${image.name} is unavailable` : `Open ${image.name}`}
      className={cn(
        TILE_CLASS,
        "enabled:hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      style={props.style}
      onClick={props.onOpen}
    >
      {failed ? (
        <ImageOffIcon aria-hidden className="size-5 text-icon-muted opacity-40" />
      ) : (
        <>
          {status === "loading" ? (
            <ImageIcon aria-hidden className="size-5 text-icon-muted opacity-40" />
          ) : null}
          {src ? (
            <img
              src={src}
              alt={image.name}
              decoding="async"
              className={cn(
                "absolute inset-0 size-full object-cover transition-opacity duration-150",
                status === "loaded" ? "opacity-100" : "opacity-0",
              )}
              onLoad={() => setStatus("loaded")}
              onError={() => setStatus("failed")}
            />
          ) : null}
        </>
      )}
    </button>
  );
}
