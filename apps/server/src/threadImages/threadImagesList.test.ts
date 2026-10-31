import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { threadImagesList } from "./threadImagesList.ts";

const at = DateTime.makeUnsafe(5);
const tool = (sourceItemId: string, fields: object) => ({
  sourceThreadId: "thread-1",
  sourceItemId,
  item: {
    type: "dynamic_tool",
    title: null,
    toolName: "Read",
    updatedAt: at,
    input: {},
    ...fields,
  },
});

describe("threadImagesList", () => {
  it("keeps only rows with images and never their image data", () => {
    const projection = {
      messages: [
        { text: "plain", createdAt: at, attachments: [] },
        { text: "see ![a](./a.png)", createdAt: at, attachments: [] },
        {
          text: "long text",
          createdAt: at,
          attachments: [
            { type: "image", id: "img-1", name: "shot.png" },
            { type: "file", id: "doc-1", name: "doc.txt" },
          ],
        },
      ],
      visibleTurnItems: [
        tool("no-image", { output: { ok: true } }),
        tool("viewed", { viewedImagePath: "/repo/view.png" }),
        tool("output", {
          output: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
        }),
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadImagesList(projection)).toEqual({
      messages: [
        { createdAtMs: 5, text: "see ![a](./a.png)", attachments: [] },
        { createdAtMs: 5, text: "", attachments: [{ id: "img-1", name: "shot.png" }] },
      ],
      toolItems: [
        {
          sourceThreadId: "thread-1",
          sourceItemId: "viewed",
          name: "Read",
          createdAtMs: 5,
          viewedImagePath: "/repo/view.png",
          outputImageCount: 0,
        },
        {
          sourceThreadId: "thread-1",
          sourceItemId: "output",
          name: "Read",
          createdAtMs: 5,
          outputImageCount: 1,
        },
      ],
    });
  });
});
