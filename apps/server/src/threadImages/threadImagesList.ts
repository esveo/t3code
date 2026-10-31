import type { OrchestrationV2ThreadProjection, ThreadImagesList } from "@t3tools/contracts";
import {
  mediaKindFromPath,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/mediaPreview";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { VIDEO_FILE_EXTENSIONS, videoMimeType } from "@t3tools/shared/video";
import * as DateTime from "effect/DateTime";

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const MARKDOWN_EMBED = /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))/g;
const MEDIA_EXTENSIONS = [
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS.map((extension) => extension.slice(1)),
  ...VIDEO_FILE_EXTENSIONS,
].join("|");
const MEDIA_PATH = new RegExp(`[^\\s\`'"()<>\\[\\]]+\\.(?:${MEDIA_EXTENSIONS})(?![\\w-])`, "gi");

/** Embedded sources, and paths or links the text only names; code fences count for neither. */
export function mediaSourcesInText(text: string) {
  const prose = text.replace(FENCED_CODE, "");
  const embeds = [...prose.matchAll(MARKDOWN_EMBED)].flatMap((match) => match[1] ?? match[2] ?? []);
  const mentions = [...new Set(prose.replace(MARKDOWN_EMBED, "").match(MEDIA_PATH) ?? [])];
  return { embeds, mentions };
}

function attachmentKind(attachment: {
  readonly type: string;
  readonly name: string;
  readonly mimeType: string;
}): "image" | "video" | null {
  if (attachment.type === "image") return "image";
  if (attachment.type !== "file") return null;
  return videoMimeType(attachment)
    ? "video"
    : mediaKindFromPath(attachment.name) === "image"
      ? "image"
      : null;
}

/** Fork: the rows of a full projection that hold media, without their payloads. */
export function threadImagesList(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "visibleTurnItems">,
): ThreadImagesList {
  const messages = projection.messages.flatMap((message) => {
    const attachments = message.attachments.flatMap((attachment) => {
      const kind = attachmentKind(attachment);
      return kind ? [{ id: attachment.id, name: attachment.name, kind }] : [];
    });
    const { embeds, mentions } = mediaSourcesInText(message.text);
    if (attachments.length + embeds.length + mentions.length === 0) return [];
    return [
      { createdAtMs: DateTime.toEpochMillis(message.createdAt), embeds, mentions, attachments },
    ];
  });
  const toolItems = projection.visibleTurnItems.flatMap(
    ({ item, sourceThreadId, sourceItemId }) => {
      if (item.type !== "dynamic_tool") return [];
      const outputImageCount = toolOutputImages(item.output).length;
      if (item.viewedImagePath === undefined && outputImageCount === 0) return [];
      return [
        {
          sourceThreadId,
          sourceItemId,
          name: item.title?.trim() || item.toolName || "Tool output",
          createdAtMs: DateTime.toEpochMillis(item.startedAt ?? item.updatedAt),
          ...(item.viewedImagePath === undefined ? {} : { viewedImagePath: item.viewedImagePath }),
          outputImageCount,
        },
      ];
    },
  );
  return { messages, toolItems };
}
