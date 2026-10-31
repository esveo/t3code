import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import type { AssetResource, EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { environmentThreads, environmentThreadShells, threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { openExpandedImagePreview } from "../chat/ExpandedImageDialog";
import { collectThreadImages, mergeThreadImages, threadTreeIds } from "./threadImages.logic";

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

  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load thread images history",
    reportFailure: false,
  });
  const treeIds = treeKey.split("\n") as ThreadId[];
  const pendingHistory = treeIds
    .filter((_, index) => {
      const history = states[index]?.history;
      return history?.hasMoreHistory && !history.loading && history.error === null;
    })
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
      return collectThreadImages(state.data.value, id, root);
    }),
  );

  const assets = images.flatMap((image) =>
    image.source._tag === "asset" ? [image.source.resource] : [],
  ) satisfies AssetResource[];
  const assetUrls = useAssetUrls(environmentId, assets);
  const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(new Set());
  let assetIndex = 0;
  const tiles = images.flatMap((image) => {
    const src = image.source._tag === "direct" ? image.source.src : assetUrls[assetIndex++];
    return src && !failedKeys.has(image.key) ? [{ ...image, src }] : [];
  });
  const loadingHistory = states.some(
    (state) => state.history.hasMoreHistory && !state.history.error,
  );

  return (
    <div className="h-full overflow-y-auto p-2">
      {tiles.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground">
          {loadingHistory ? "Loading images…" : "No images in this thread yet."}
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
          {tiles.map((tile, index) => (
            <button
              key={tile.key}
              type="button"
              aria-label={`Open ${tile.name}`}
              className="aspect-square overflow-hidden rounded-md border border-border/60 bg-muted/20 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                openExpandedImagePreview(scopedThreadKey(props.threadRef), {
                  images: tiles.map(({ src, name }) => ({ src, name })),
                  index,
                })
              }
            >
              <img
                src={tile.src}
                alt={tile.name}
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
                onError={() => setFailedKeys((keys) => new Set(keys).add(tile.key))}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
