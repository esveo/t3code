import type { OrchestrationV2ThreadProjection, ThreadImagesList } from "@t3tools/contracts";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

/** Fork: the rows of a full projection that hold images, without their payloads. */
export function threadImagesList(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "visibleTurnItems">,
): ThreadImagesList {
  const messages = projection.messages.flatMap((message) => {
    const attachments = message.attachments.flatMap((attachment) =>
      attachment.type === "image" ? [{ id: attachment.id, name: attachment.name }] : [],
    );
    const text = message.text.includes("![") ? message.text : "";
    if (attachments.length === 0 && text === "") return [];
    return [{ createdAtMs: DateTime.toEpochMillis(message.createdAt), text, attachments }];
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
