import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  buildEsveoConicWedges,
  isEsveoLiveUserMessage,
  markEsveoLiveUserMessage,
  sampleEsveoConic,
} from "./esveoMidnightModel";

describe("sampleEsveoConic", () => {
  it("hits the web ring's stops", () => {
    expect(sampleEsveoConic(80)).toEqual({ r: 3, g: 168, b: 255, a: 0.18 });
    expect(sampleEsveoConic(170).a).toBe(0);
    expect(sampleEsveoConic(352)).toEqual({ r: 104, g: 229, b: 222, a: 1 });
  });

  it("fades into transparent without darkening", () => {
    expect(sampleEsveoConic(40)).toEqual({ r: 3, g: 168, b: 255, a: 0.09 });
  });
});

describe("buildEsveoConicWedges", () => {
  it("leaves out the ring's dark stretch", () => {
    const wedges = buildEsveoConicWedges();
    expect(wedges.length).toBeGreaterThan(60);
    expect(wedges.length).toBeLessThan(120);
  });
});

describe("live user message", () => {
  it("stays live until every feed showing it lets go", () => {
    const releaseFirst = markEsveoLiveUserMessage("m1");
    const releaseSecond = markEsveoLiveUserMessage("m1");
    releaseFirst();
    expect(isEsveoLiveUserMessage("m1")).toBe(true);
    releaseSecond();
    expect(isEsveoLiveUserMessage("m1")).toBe(false);
  });
});

// The gradients mount inside upstream components. If a merge drops a mount
// point, the theme silently falls back to its flat colours.
describe("mount points", () => {
  const read = (path: string) =>
    NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, path), "utf8");

  it("are still in the feed and the composer", () => {
    const feed = read("../threads/ThreadFeed.tsx");
    expect(feed).toContain("<EsveoUserBubbleBackdrop messageId={message.id} />");
    expect(feed).toContain("useEsveoLiveUserMessage(props.feed");
    expect(read("../../components/ComposerToolbar.tsx")).toContain("<EsveoActionFill");
  });
});
