import type { ThreadId, ThreadImagesList } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadImages,
  gridWindow,
  mergeThreadImages,
  threadTreeIds,
  type ThreadImage,
} from "./threadImages.logic";

const threadId = "thread-1" as ThreadId;

describe("threadTreeIds", () => {
  it("walks subagents and sub-threads below the thread, not siblings", () => {
    const shell = (id: string, parentThreadId: string | null, forkedFrom: unknown = null) =>
      ({ id, lineage: { parentThreadId }, forkedFrom }) as never;
    const ids = threadTreeIds(threadId, [
      shell("child", "thread-1"),
      shell("grandchild", "child"),
      shell("fork", null, { type: "run", threadId: "thread-1" }),
      shell("sibling", "other"),
    ]);
    expect(ids).toEqual(["thread-1", "child", "fork", "grandchild"]);
  });
});

describe("collectThreadImages", () => {
  it("collects attachments, viewed files and omitted tool output by source ids", () => {
    const list = {
      messages: [
        {
          embeds: ["./clip.mp4"],
          mentions: ["out/maybe.gif"],
          createdAtMs: 1,
          attachments: [{ id: "img-1", name: "shot.png", kind: "image" }],
        },
      ],
      toolItems: [
        {
          sourceThreadId: "parent",
          sourceItemId: "item-1",
          name: "Screenshot",
          createdAtMs: 2,
          outputImageCount: 2,
        },
        {
          sourceThreadId: "thread-1",
          sourceItemId: "item-2",
          name: "Read",
          createdAtMs: 3,
          viewedImagePath: "/repo/view.png",
          outputImageCount: 0,
        },
      ],
    } as unknown as ThreadImagesList;

    const images = collectThreadImages(list, threadId, "/repo");
    expect(images.map((image) => image.key)).toEqual([
      "attachment:img-1",
      "file:thread-1:./clip.mp4",
      "file:thread-1:out/maybe.gif",
      "tool:parent:item-1:0",
      "tool:parent:item-1:1",
      "viewed:thread-1:item-2",
    ]);
    expect(images[1]).toMatchObject({ kind: "video" });
    expect(images[2]).toMatchObject({ kind: "image", mentioned: true });
    expect(images[4]?.source).toEqual({
      _tag: "asset",
      resource: { _tag: "tool-output-image", threadId: "parent", itemId: "item-1", index: 1 },
    });
  });
});

describe("mergeThreadImages", () => {
  it("sorts newest first and keeps inherited images once", () => {
    const image = (key: string, createdAtMs: number) =>
      ({
        key,
        createdAtMs,
        name: key,
        kind: "image",
        source: { _tag: "direct", src: key },
      }) as ThreadImage;
    const merged = mergeThreadImages([
      [image("old", 1), image("shared", 2)],
      [image("shared", 2), image("new", 3)],
    ]);
    expect(merged.map((entry) => entry.key)).toEqual(["new", "shared", "old"]);
  });
});

describe("gridWindow", () => {
  it("only includes tiles near the viewport", () => {
    // 496 wide fits 4 tiles of 114px; rows are 122px, so scrolling 1220 starts at row 10.
    const grid = gridWindow({ width: 496, height: 244, scrollTop: 1220, count: 400 });
    expect(grid.columns).toBe(4);
    expect(grid.first).toBe(8 * 4);
    expect(grid.last).toBe(14 * 4);
    expect(grid.totalHeight).toBe(100 * 122 - 8);
  });

  it("clamps to the image count and renders nothing before it is measured", () => {
    expect(gridWindow({ width: 496, height: 800, scrollTop: 0, count: 3 }).last).toBe(3);
    expect(gridWindow({ width: 0, height: 0, scrollTop: 0, count: 3 }).last).toBe(0);
  });
});
