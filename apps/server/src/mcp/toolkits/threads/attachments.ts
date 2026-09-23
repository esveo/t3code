/**
 * Fork: thread orchestration. Hands attachments from a coordinator to a child
 * thread. Each one is copied into the attachment store under the child's id,
 * exactly as an upload from the composer would be claimed, so the child sees
 * it as if the user had attached it there.
 */
import {
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  type OrchestrationMessage,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Mime from "effect/unstable/http/Mime";

import {
  attachmentFileExtension,
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import { ThreadOrchestrationFailedError, type ThreadAttachmentInput } from "./tools.ts";

const failure = (detail: string) => new ThreadOrchestrationFailedError({ detail });

type KnownAttachment = ChatImageAttachment | ChatFileAttachment;

/** An attachment to hand over, before it has an id in the target thread. */
export interface AttachmentSource {
  readonly attachment: Omit<ChatImageAttachment, "id"> | Omit<ChatFileAttachment, "id">;
  readonly sourcePath: string;
}

const isKnownAttachment = (attachment: ChatAttachment): attachment is KnownAttachment =>
  attachment.type === "image" || attachment.type === "file";

/**
 * The stored attachment an id refers to: an attachment id itself, or the
 * context id of a `t3-context://v1/file/<contextId>` reference, as the agent
 * sees it in its prompt (`ref=file_…`).
 */
export function findMessageAttachment(
  messages: ReadonlyArray<OrchestrationMessage>,
  reference: string,
): ChatAttachment | undefined {
  for (const message of messages) {
    const attachments = message.attachments ?? [];
    const direct = attachments.find((attachment) => attachment.id === reference);
    if (direct) return direct;
    const record = message.context?.records.find(
      (candidate) => candidate.contextId === reference && "attachmentId" in candidate,
    );
    if (record && "attachmentId" in record) {
      const bound = attachments.find((attachment) => attachment.id === record.attachmentId);
      if (bound) return bound;
    }
  }
  return undefined;
}

/** What read_thread reports about a message's attachments. */
export function describeMessageAttachments(
  messages: ReadonlyArray<OrchestrationMessage>,
  attachmentsDir: string,
) {
  return messages.flatMap((message) =>
    (message.attachments ?? []).filter(isKnownAttachment).map((attachment) => ({
      messageId: message.id,
      role: message.role,
      attachmentId: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      path: resolveAttachmentPath({ attachmentsDir, attachment }),
    })),
  );
}

/** How a local file travels: as an image when a provider can take it as one, else as a file. */
export function classifyLocalFile(input: {
  readonly name: string;
  readonly sizeBytes: number;
}): { readonly type: "image" | "file"; readonly mimeType: string } | string {
  const mimeType = Option.getOrElse(
    Mime.getType(input.name),
    () => "application/octet-stream",
  ).toLowerCase();
  if (
    isProviderSendTurnSupportedImageMimeType(mimeType) &&
    input.sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  ) {
    return { type: "image", mimeType };
  }
  if (input.sizeBytes < 1) return `${input.name} is empty.`;
  if (input.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return `${input.name} is larger than ${PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024)} MiB.`;
  }
  return { type: "file", mimeType };
}

export const makeThreadAttachments = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;

  /**
   * Resolves what a coordinator asked to attach. `threadsToSearch` lists the
   * threads whose messages an id may come from, in order; the thread an
   * attachment id names is searched first.
   */
  const resolve = Effect.fn("ThreadAttachments.resolve")(function* (input: {
    readonly attachments: ReadonlyArray<ThreadAttachmentInput>;
    readonly threadsToSearch: ReadonlyArray<ThreadId>;
    readonly readMessages: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationMessage>, ThreadOrchestrationFailedError>;
  }) {
    const messagesByThread = new Map<string, ReadonlyArray<OrchestrationMessage>>();
    const findStored = Effect.fn("ThreadAttachments.findStored")(function* (reference: string) {
      const namedThread = parseThreadSegmentFromAttachmentId(reference);
      const candidates = [
        ...new Set([...(namedThread ? [namedThread] : []), ...input.threadsToSearch.map(String)]),
      ];
      for (const threadId of candidates) {
        let messages = messagesByThread.get(threadId);
        if (!messages) {
          messages = yield* input
            .readMessages(threadId as ThreadId)
            .pipe(Effect.orElseSucceed((): ReadonlyArray<OrchestrationMessage> => []));
          messagesByThread.set(threadId, messages);
        }
        const found = findMessageAttachment(messages, reference);
        if (found) return found;
      }
      return undefined;
    });

    const sources: AttachmentSource[] = [];
    for (const entry of input.attachments) {
      if ((entry.path === undefined) === (entry.attachmentId === undefined)) {
        return yield* failure("Give each attachment either a path or an attachmentId.");
      }
      if (entry.attachmentId !== undefined) {
        const stored = yield* findStored(entry.attachmentId);
        if (!stored || !isKnownAttachment(stored)) {
          return yield* failure(
            `No attachment ${entry.attachmentId} was found in this thread or the threads you started. Pass its path instead.`,
          );
        }
        const sourcePath = resolveAttachmentPath({ attachmentsDir, attachment: stored });
        if (!sourcePath) return yield* failure(`Attachment ${entry.attachmentId} has no file.`);
        const { id: _id, ...attachment } = stored;
        sources.push({
          attachment: entry.name ? { ...attachment, name: entry.name } : attachment,
          sourcePath,
        });
        continue;
      }
      const sourcePath = entry.path!;
      if (!path.isAbsolute(sourcePath)) {
        return yield* failure(`${sourcePath} is not an absolute path.`);
      }
      const info = yield* fileSystem
        .stat(sourcePath)
        .pipe(Effect.mapError(() => failure(`${sourcePath} does not exist or cannot be read.`)));
      if (info.type !== "File") return yield* failure(`${sourcePath} is not a file.`);
      const name = entry.name ?? path.basename(sourcePath);
      const sizeBytes = Number(info.size);
      const kind = classifyLocalFile({ name, sizeBytes });
      if (typeof kind === "string") return yield* failure(kind);
      sources.push({ attachment: { ...kind, name, sizeBytes }, sourcePath });
    }
    const limitError = getProviderAttachmentLimitError(sources.map((source) => source.attachment));
    if (limitError) return yield* failure(limitError);
    return sources;
  });

  /** Copies the sources into the attachment store as attachments of `threadId`. */
  const claim = Effect.fn("ThreadAttachments.claim")(function* (
    threadId: ThreadId,
    sources: ReadonlyArray<AttachmentSource>,
  ) {
    const claimed: ChatAttachment[] = [];
    const written: string[] = [];
    const removeWritten = Effect.forEach(written, (file) =>
      fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
    );
    return yield* Effect.gen(function* () {
      for (const source of sources) {
        const id =
          source.attachment.type === "image"
            ? createAttachmentId(threadId)
            : createAttachmentId(threadId, attachmentFileExtension(source.attachment.name));
        if (!id) return yield* failure("Could not create an attachment id.");
        const attachment = { ...source.attachment, id } as KnownAttachment;
        const target = resolveAttachmentPath({ attachmentsDir, attachment });
        if (!target) return yield* failure(`Could not store ${attachment.name}.`);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.copyFile(source.sourcePath, target);
        written.push(target);
        claimed.push(attachment);
      }
      return claimed;
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(failure(`Could not copy the attachment: ${error.message}`)),
      ),
      Effect.tapError(() => removeWritten),
    );
  });

  /** Removes attachments claimed for a message that was then not sent. */
  const release = (attachments: ReadonlyArray<ChatAttachment>) =>
    Effect.forEach(attachments, (attachment) => {
      const file = resolveAttachmentPath({ attachmentsDir, attachment });
      return file ? fileSystem.remove(file, { force: true }).pipe(Effect.ignore) : Effect.void;
    });

  return { resolve, claim, release, attachmentsDir };
});
