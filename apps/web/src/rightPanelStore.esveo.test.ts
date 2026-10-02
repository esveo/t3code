import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadPanelOpen,
  setEsveoThreadPanelOpenByDefault,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

const inlineOpen = (ref: typeof refA) =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    ref,
    "inline",
  );

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
});

afterEach(() => setEsveoThreadPanelOpenByDefault(true));

describe("thread details open by default (fork)", () => {
  it("starts threads closed when the default is off and keeps a thread the user opened", () => {
    setEsveoThreadPanelOpenByDefault(false);
    expect(inlineOpen(refA)).toBe(false);

    useRightPanelStore.getState().toggleThreadPanel(refA, "inline");
    expect(inlineOpen(refA)).toBe(true);
    expect(inlineOpen(refB)).toBe(false);
  });

  it("moves threads without a choice of their own when the default changes", () => {
    useRightPanelStore.getState().setThreadPanelOpen(refA, "inline", false);
    setEsveoThreadPanelOpenByDefault(false);
    useRightPanelStore.getState().setThreadPanelOpen(refA, "inline", false);

    setEsveoThreadPanelOpenByDefault(true);
    expect(inlineOpen(refA)).toBe(true);
    expect(inlineOpen(refB)).toBe(true);
  });

  it("persists a thread's open choice so it survives a reload", () => {
    setEsveoThreadPanelOpenByDefault(false);
    useRightPanelStore.getState().setThreadPanelOpen(refA, "inline", true);

    const persisted = useRightPanelStore.persist
      .getOptions()
      .partialize?.(useRightPanelStore.getState()) as {
      threadPanelVisibilityByThreadKey: Record<string, unknown>;
    };
    expect(persisted.threadPanelVisibilityByThreadKey).toEqual({
      "env-1:thread-A": { inlineOpen: true, popoverOpen: false },
    });
  });
});
