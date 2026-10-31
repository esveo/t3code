import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  THREAD_IMAGES_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { ImageIcon, ImageOffIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { type CSSProperties, useEffect, useState } from "react";

import { resolveAssetUrl, useAssetUrlState } from "~/assets/assetUrls";
import { connectionAtomRuntime } from "~/connection/runtime";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import {
  collectThreadImagesCached,
  gridWindow,
  mergeThreadImages,
  threadTreeIds,
  type ThreadImage,
} from "./threadImages.logic";
import { cachedThumbnail, loadThumbnail } from "./threadImageThumbnails";

const PLACEHOLDER_ROWS_WHILE_LOADING = 2;
// ponytail: the preview pages through this many neighbours per side, as each needs its own URL.
const PREVIEW_NEIGHBOURS = 20;

const TILE_CLASS =
  "absolute flex items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/30";

const threadImagesListAtom = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-images",
  tag: THREAD_IMAGES_WS_METHODS.list,
  // ponytail: refetches every few items and at run changes, not per image; push if that feels late.
  refreshTrigger: ({ environmentId, input: { threadId } }) =>
    Atom.map(environmentThreadShells.threadShellAtom({ environmentId, threadId }), (shell) =>
      shell
        ? [
            shell.latestRun?.runId,
            shell.latestRun?.status,
            shell.runtime?.status,
            Math.floor(shell.itemCount / 8),
          ].join()
        : null,
    ),
});

interface ThreadTreeEntry {
  readonly id: ThreadId;
  readonly root?: string;
}

// A string, so the panel skips the updates every running thread sends through the shells.
const threadTreeKeyAtom = Atom.family((key: string) => {
  const [environmentId, threadId, workspaceRoot] = JSON.parse(key) as [
    EnvironmentId,
    ThreadId,
    string | undefined,
  ];
  return Atom.make((get) => {
    const shells = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const worktreeById = new Map(shells.map((shell) => [shell.id, shell.worktreePath]));
    return JSON.stringify(
      threadTreeIds(threadId, shells).map((id) => ({
        id,
        root: id === threadId ? workspaceRoot : (worktreeById.get(id) ?? workspaceRoot),
      })),
    );
  });
});

const threadTreeImagesAtom = Atom.family((key: string) => {
  const [environmentId, treeKey] = JSON.parse(key) as [EnvironmentId, string];
  const tree = JSON.parse(treeKey) as ReadonlyArray<ThreadTreeEntry>;
  return Atom.make((get) => {
    const results = tree.map(({ id }) =>
      get(threadImagesListAtom({ environmentId, input: { threadId: id } })),
    );
    return {
      images: mergeThreadImages(
        results.map((result, index) => {
          const list = Option.getOrUndefined(AsyncResult.value(result));
          const entry = tree[index];
          return list && entry ? collectThreadImagesCached(list, entry.id, entry.root) : [];
        }),
      ),
      loading: results.some(
        (result) => Option.isNone(AsyncResult.value(result)) && !AsyncResult.isFailure(result),
      ),
    };
  });
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
  const treeKey = useAtomValue(
    threadTreeKeyAtom(JSON.stringify([environmentId, threadId, props.workspaceRoot])),
  );
  const { images, loading } = useAtomValue(
    threadTreeImagesAtom(JSON.stringify([environmentId, treeKey])),
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
          Loading images… {images.length} so far
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
  const [thumbnail, setThumbnail] = useState(() => cachedThumbnail(image.key));
  const asset = useAssetUrlState(
    props.environmentId,
    image.source._tag === "asset" && thumbnail === undefined ? image.source.resource : null,
  );
  const src =
    image.source._tag === "direct" ? image.source.src : asset._tag === "Success" ? asset.url : null;
  // oxlint-disable-next-line t3code/react-effect-budget -- fetches and decodes outside React, only while this tile is on screen.
  useEffect(() => {
    if (src === null || thumbnail !== undefined) return;
    let current = true;
    void loadThumbnail(image.key, src).then((url) => {
      if (current) setThumbnail(url);
    });
    return () => {
      current = false;
    };
  }, [image.key, src, thumbnail]);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  const failed =
    status === "failed" ||
    (image.source._tag === "asset" && thumbnail === undefined && asset._tag === "Failure");
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
          {thumbnail ? (
            <img
              src={thumbnail}
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
