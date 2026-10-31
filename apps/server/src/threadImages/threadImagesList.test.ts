import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { mediaSourcesInText, threadImagesList } from "./threadImagesList.ts";

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

describe("mediaSourcesInText", () => {
  it("separates embeds from named paths in every format, not those inside code fences", () => {
    const text = [
      "![a](./a.png) ![b](<./my b.gif> 'title') ![c](./c.mp4)",
      "Saved `out/demo.WEBM`, see [clip](https://x.dev/v.mov) and art.svg.",
      "not media: notes.txt v1.mp4x",
      "```\n![d](./d.png) e.gif\n```",
    ].join("\n");
    expect(mediaSourcesInText(text)).toEqual({
      embeds: ["./a.png", "./my b.gif", "./c.mp4"],
      mentions: ["out/demo.WEBM", "https://x.dev/v.mov", "art.svg"],
    });
  });
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
            { type: "image", id: "img-1", name: "shot.png", mimeType: "image/png" },
            { type: "file", id: "doc-1", name: "doc.txt", mimeType: "text/plain" },
            { type: "file", id: "clip-1", name: "clip.mp4", mimeType: "application/octet-stream" },
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
        { createdAtMs: 5, embeds: ["./a.png"], mentions: [], attachments: [] },
        {
          createdAtMs: 5,
          embeds: [],
          mentions: [],
          attachments: [
            { id: "img-1", name: "shot.png", kind: "image" },
            { id: "clip-1", name: "clip.mp4", kind: "video" },
          ],
        },
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
