import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import type {
  AssetResource,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { turnItemOutputImages } from "@t3tools/client-runtime/work-log/item-detail";
import * as DateTime from "effect/DateTime";

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

/** Every image one thread's loaded history shows: attachments, markdown, viewed files, tool output. */
export function collectThreadImages(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "visibleTurnItems">,
  threadId: ThreadId,
  workspaceRoot: string | undefined,
): ReadonlyArray<ThreadImage> {
  const images: ThreadImage[] = [];
  for (const message of projection.messages) {
    const createdAtMs = DateTime.toEpochMillis(message.createdAt);
    for (const attachment of message.attachments) {
      if (attachment.type !== "image") continue;
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
  for (const { item, sourceThreadId, sourceItemId } of projection.visibleTurnItems) {
    if (item.type !== "dynamic_tool") continue;
    const createdAtMs = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
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
    const count = item.outputImageCount ?? turnItemOutputImages(item).length;
    for (let index = 0; index < count; index++) {
      images.push({
        key: `tool:${sourceThreadId}:${sourceItemId}:${index}`,
        name: item.title?.trim() || item.toolName || "Tool output",
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
