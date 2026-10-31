/**
 * Fork: what the right panel's Images tab lists for one thread.
 *
 * The environment reads the whole history and answers with only the rows that
 * hold images, so the gallery never pages a transcript into the client.
 *
 * @module threadImages
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ForwardCompatibleArray, ThreadId, TurnItemId } from "./baseSchemas.ts";

export const THREAD_IMAGES_WS_METHODS = {
  list: "threadImages.list",
} as const;

export const ThreadImagesListInput = Schema.Struct({ threadId: ThreadId });
export type ThreadImagesListInput = typeof ThreadImagesListInput.Type;

export const ThreadImagesMessage = Schema.Struct({
  createdAtMs: Schema.Number,
  /** Markdown embeds in the text. */
  embeds: ForwardCompatibleArray(Schema.String),
  /** Media paths and links the text only names; they may not exist. */
  mentions: ForwardCompatibleArray(Schema.String),
  attachments: ForwardCompatibleArray(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      kind: Schema.Literals(["image", "video"]),
    }),
  ),
});
export type ThreadImagesMessage = typeof ThreadImagesMessage.Type;

export const ThreadImagesToolItem = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceItemId: TurnItemId,
  name: Schema.String,
  createdAtMs: Schema.Number,
  viewedImagePath: Schema.optional(Schema.String),
  outputImageCount: Schema.Number,
});
export type ThreadImagesToolItem = typeof ThreadImagesToolItem.Type;

export const ThreadImagesList = Schema.Struct({
  messages: ForwardCompatibleArray(ThreadImagesMessage),
  toolItems: ForwardCompatibleArray(ThreadImagesToolItem),
});
export type ThreadImagesList = typeof ThreadImagesList.Type;

export class ThreadImagesReadError extends Schema.TaggedError<ThreadImagesReadError>()(
  "ThreadImagesReadError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Thread images could not be read.";
  }
}

export const WsThreadImagesListRpc = Rpc.make(THREAD_IMAGES_WS_METHODS.list, {
  payload: ThreadImagesListInput,
  success: ThreadImagesList,
  error: Schema.Union([ThreadImagesReadError, EnvironmentAuthorizationError]),
});
