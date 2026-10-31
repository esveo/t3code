import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import type {
  AssetResource,
  OrchestrationV2ThreadShell,
  ThreadId,
  ThreadImagesList,
} from "@t3tools/contracts";

import { shellParentThreadId } from "~/state/entities";
import { resolveProtocolRelativeMediaUrl } from "../media/mediaContent";

export type ThreadImageSource =
  | { readonly _tag: "asset"; readonly resource: AssetResource }
  | { readonly _tag: "direct"; readonly src: string };

export interface ThreadImage {
  readonly key: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly source: ThreadImageSource;
}

/** The thread and every thread below it, in walk order. */
export function threadTreeIds(
  rootThreadId: ThreadId,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<ThreadId> {
  const ids = [rootThreadId];
  const seen = new Set<ThreadId>(ids);
  for (const id of ids) {
    for (const thread of threads) {
      if (seen.has(thread.id) || shellParentThreadId(thread) !== id) continue;
      seen.add(thread.id);
      ids.push(thread.id);
    }
  }
  return ids;
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))/g;
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;

export function markdownImageSources(text: string): ReadonlyArray<string> {
  if (!text.includes("![")) return [];
  const sources: string[] = [];
  for (const match of text.replace(FENCED_CODE, "").matchAll(MARKDOWN_IMAGE)) {
    const source = match[1] ?? match[2];
    if (source) sources.push(source);
  }
  return sources;
}

function markdownImage(
  source: string,
  threadId: ThreadId,
  workspaceRoot: string | undefined,
  createdAtMs: number,
): ThreadImage | null {
  const media = resolveMediaSource(source, { threadId, workspaceRoot, imageEmbed: true });
  if (media === null || media.kind !== "image" || media.access === "unavailable") return null;
  return media.access === "direct"
    ? {
        key: `direct:${media.uri}`,
        name: media.name,
        createdAtMs,
        source: { _tag: "direct", src: resolveProtocolRelativeMediaUrl(media.uri) },
      }
    : {
        key: `file:${threadId}:${source}`,
        name: media.name,
        createdAtMs,
        source: { _tag: "asset", resource: media.resource },
      };
}

/** Every image of one thread's list: attachments, markdown, viewed files, tool output. */
export function collectThreadImages(
  list: ThreadImagesList,
  threadId: ThreadId,
  workspaceRoot: string | undefined,
): ReadonlyArray<ThreadImage> {
  const images: ThreadImage[] = [];
  for (const message of list.messages) {
    const { createdAtMs } = message;
    for (const attachment of message.attachments) {
      images.push({
        key: `attachment:${attachment.id}`,
        name: attachment.name,
        createdAtMs,
        source: { _tag: "asset", resource: { _tag: "attachment", attachmentId: attachment.id } },
      });
    }
    for (const source of markdownImageSources(message.text)) {
      const image = markdownImage(source, threadId, workspaceRoot, createdAtMs);
      if (image) images.push(image);
    }
  }
  for (const item of list.toolItems) {
    const { sourceThreadId, sourceItemId, createdAtMs, name } = item;
    const viewedPath = extractToolActivityPresentation(item).viewedImagePath;
    const viewed = viewedPath
      ? resolveViewedImageAsset(viewedPath, { threadId, workspaceRoot })
      : null;
    if (viewed) {
      images.push({
        key: `viewed:${sourceThreadId}:${sourceItemId}`,
        name: viewed.alt,
        createdAtMs,
        source: { _tag: "asset", resource: viewed.resource },
      });
    }
    for (let index = 0; index < item.outputImageCount; index++) {
      images.push({
        key: `tool:${sourceThreadId}:${sourceItemId}:${index}`,
        name,
        createdAtMs,
        source: {
          _tag: "asset",
          resource: {
            _tag: "tool-output-image",
            threadId: sourceThreadId,
            itemId: sourceItemId,
            index,
          },
        },
      });
    }
  }
  return images;
}

/** Newest first; a fork inherits its parent's rows, so the same image counts once. */
export function mergeThreadImages(
  lists: ReadonlyArray<ReadonlyArray<ThreadImage>>,
): ReadonlyArray<ThreadImage> {
  const byKey = new Map<string, ThreadImage>();
  for (const image of lists.flat()) {
    if (!byKey.has(image.key)) byKey.set(image.key, image);
  }
  return [...byKey.values()].toSorted((a, b) => b.createdAtMs - a.createdAtMs);
}

const collectedByList = new WeakMap<object, ReadonlyArray<ThreadImage>>();

/** An unchanged refetch keeps its object, so refreshing one thread rescans only that one. */
export function collectThreadImagesCached(
  list: ThreadImagesList,
  threadId: ThreadId,
  workspaceRoot: string | undefined,
): ReadonlyArray<ThreadImage> {
  const cached = collectedByList.get(list);
  if (cached) return cached;
  const images = collectThreadImages(list, threadId, workspaceRoot);
  collectedByList.set(list, images);
  return images;
}

const MIN_TILE_SIZE = 112;
const TILE_GAP = 8;
const GRID_MARGIN = 8;
const OVERSCAN_ROWS = 2;

/** Which tiles of a fixed square grid are near the viewport; offscreen images stay unmounted. */
export function gridWindow(input: {
  readonly width: number;
  readonly height: number;
  readonly scrollTop: number;
  readonly count: number;
}) {
  const innerWidth = Math.max(0, input.width - GRID_MARGIN * 2);
  const columns = Math.max(1, Math.floor((innerWidth + TILE_GAP) / (MIN_TILE_SIZE + TILE_GAP)));
  const tileSize = Math.max(MIN_TILE_SIZE, (innerWidth - (columns - 1) * TILE_GAP) / columns);
  const rowHeight = tileSize + TILE_GAP;
  const rows = Math.ceil(input.count / columns);
  const firstRow = Math.max(0, Math.floor(input.scrollTop / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.ceil((input.scrollTop + input.height) / rowHeight) + OVERSCAN_ROWS;
  return {
    columns,
    tileSize,
    gap: TILE_GAP,
    first: Math.min(input.count, firstRow * columns),
    last: input.width === 0 ? 0 : Math.min(input.count, lastRow * columns),
    totalHeight: Math.max(0, rows * rowHeight - TILE_GAP),
  };
}
