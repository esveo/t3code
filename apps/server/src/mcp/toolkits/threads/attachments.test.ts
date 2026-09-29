// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ChatAttachment, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ThreadCoordinators } from "../../../threadOrchestration/ThreadCoordinators.ts";
import * as DelegatedAttachments from "./attachments.ts";

const COORDINATOR = ThreadId.make("coordinator");
const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-delegated-attachments-"));
const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const withAttachments = <A, E>(
  messageAttachments: ReadonlyArray<ChatAttachment>,
  body: Effect.Effect<A, E, DelegatedAttachments.DelegatedAttachments | ServerConfig.ServerConfig>,
) =>
  body.pipe(
    Effect.provide(
      DelegatedAttachments.layer.pipe(
        Layer.provideMerge(configLayer),
        Layer.provide(
          Layer.mock(ThreadManagementService)({
            ensureLegacyTranscript: () => Effect.void,
            getThreadRecords: (() =>
              Effect.succeed({
                messages: [
                  {
                    id: MessageId.make("user-message"),
                    role: "user",
                    text: "Here is the design.",
                    attachments: messageAttachments,
                  },
                ],
              })) as never,
          }),
        ),
        Layer.provide(Layer.mock(ThreadCoordinators)({ childrenOf: () => Effect.succeed([]) })),
      ),
    ),
  );

describe("delegate_task attachments", () => {
  it.effect("claims a local file and a file of the coordinator's thread for the child", () =>
    Effect.gen(function* () {
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const brief = NodePath.join(baseDir, "brief.md");
      NodeFS.writeFileSync(brief, "# Brief\n");
      const design = {
        type: "file" as const,
        id: "coordinator-00000000-0000-4000-8000-000000000001-md",
        name: "design.md",
        mimeType: "text/markdown",
        sizeBytes: 9,
      };
      const designPath = resolveAttachmentPath({ attachmentsDir, attachment: design })!;
      NodeFS.mkdirSync(NodePath.dirname(designPath), { recursive: true });
      NodeFS.writeFileSync(designPath, "# Design\n");

      const claimed = yield* withAttachments(
        [design],
        DelegatedAttachments.claimDelegatedAttachments(COORDINATOR, [
          { path: brief },
          { attachmentId: design.id, name: "spec.md" },
        ]),
      );
      assert.deepEqual(
        claimed.map((attachment) => [attachment.type, attachment.name]),
        [
          ["file", "brief.md"],
          ["file", "spec.md"],
        ],
      );
      const files = claimed.map((attachment) =>
        resolveAttachmentPath({ attachmentsDir, attachment })!,
      );
      assert.notInclude(files, designPath);
      assert.deepEqual(
        files.map((file) => NodeFS.readFileSync(file, "utf8")),
        ["# Brief\n", "# Design\n"],
      );

      // A task that was not created gives its files back.
      yield* withAttachments([], DelegatedAttachments.releaseDelegatedAttachments(claimed));
      assert.deepEqual(
        files.map((file) => NodeFS.existsSync(file)),
        [false, false],
      );
    }).pipe(Effect.provide(configLayer)),
  );

  it.effect("refuses what it cannot attach, before anything is created", () =>
    Effect.gen(function* () {
      const missing = yield* withAttachments(
        [],
        DelegatedAttachments.claimDelegatedAttachments(COORDINATOR, [
          { attachmentId: "coordinator-00000000-0000-4000-8000-00000000dead" },
        ]),
      ).pipe(Effect.flip);
      assert.include(missing.message, "Pass its path instead");
      const relative = yield* withAttachments(
        [],
        DelegatedAttachments.claimDelegatedAttachments(COORDINATOR, [{ path: "brief.md" }]),
      ).pipe(Effect.flip);
      assert.include(relative.message, "not an absolute path");
      // Without files there is nothing to claim, even without the service.
      assert.deepEqual(yield* DelegatedAttachments.claimDelegatedAttachments(COORDINATOR, []), []);
    }),
  );
});
