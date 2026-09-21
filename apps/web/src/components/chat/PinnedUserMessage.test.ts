import { describe, expect, it } from "vite-plus/test";
import { compactPinnedUserMessageText, resolvePinnedUserMessageIndex } from "./PinnedUserMessage";

describe("resolvePinnedUserMessageIndex", () => {
  const bounds = [
    { top: 0, height: 60 },
    { top: 400, height: 60 },
    { top: 900, height: 60 },
  ];

  it("pins nothing while the prompt is still on screen", () => {
    // The first message is partly visible at the top edge.
    expect(resolvePinnedUserMessageIndex({ scrollTop: 40, itemBounds: bounds })).toBeNull();
    expect(resolvePinnedUserMessageIndex({ scrollTop: 0, itemBounds: bounds })).toBeNull();
  });

  it("pins a prompt once its last pixel leaves the top edge", () => {
    expect(resolvePinnedUserMessageIndex({ scrollTop: 60, itemBounds: bounds })).toBe(0);
    expect(resolvePinnedUserMessageIndex({ scrollTop: 300, itemBounds: bounds })).toBe(0);
  });

  it("hands over to the next prompt only after that one scrolls past too", () => {
    // The second prompt is in view: the reader still sees it, so the header
    // keeps standing in for the turn above it.
    expect(resolvePinnedUserMessageIndex({ scrollTop: 420, itemBounds: bounds })).toBe(0);
    expect(resolvePinnedUserMessageIndex({ scrollTop: 460, itemBounds: bounds })).toBe(1);
    expect(resolvePinnedUserMessageIndex({ scrollTop: 5000, itemBounds: bounds })).toBe(2);
  });

  it("skips rows the virtualizer has not measured", () => {
    expect(
      resolvePinnedUserMessageIndex({
        scrollTop: 460,
        itemBounds: [{ top: null, height: null }, ...bounds.slice(1)],
      }),
    ).toBe(1);
  });

  it("treats unmeasured heights as a single pixel", () => {
    expect(
      resolvePinnedUserMessageIndex({ scrollTop: 1, itemBounds: [{ top: 0, height: null }] }),
    ).toBe(0);
    expect(
      resolvePinnedUserMessageIndex({ scrollTop: 0, itemBounds: [{ top: 0, height: null }] }),
    ).toBeNull();
  });

  it("pins nothing without messages", () => {
    expect(resolvePinnedUserMessageIndex({ scrollTop: 800, itemBounds: [] })).toBeNull();
  });
});

describe("compactPinnedUserMessageText", () => {
  it("collapses a multi-line prompt into one line", () => {
    expect(compactPinnedUserMessageText("  fix the\n\n  scroll bug ")).toBe("fix the scroll bug");
  });

  it("returns null for a message without text", () => {
    expect(compactPinnedUserMessageText(null)).toBeNull();
    expect(compactPinnedUserMessageText("   \n ")).toBeNull();
  });
});
