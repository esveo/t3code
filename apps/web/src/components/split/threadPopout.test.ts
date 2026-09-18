import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPopoutPathname,
  openThreadPopout,
  popoutPathForThread,
  popoutWindowFeatures,
  type ThreadPopoutHost,
} from "./threadPopout";

const thread = (threadId: string): ScopedThreadRef => ({
  environmentId: "env-1" as EnvironmentId,
  threadId: threadId as ThreadId,
});

function makeHost(openedWindows: Array<{ url: string; name: string; closed: boolean }>) {
  const focused: string[] = [];
  const host: ThreadPopoutHost = {
    open: (url, name) => {
      const record = { url, name, closed: false };
      openedWindows.push(record);
      return {
        get closed() {
          return record.closed;
        },
        focus: () => focused.push(name),
      } as unknown as Window;
    },
    screenX: 100,
    screenY: 50,
    origin: "https://app.example",
    hashRouting: false,
  };
  return { host, focused };
}

describe("popoutPathForThread", () => {
  it("encodes ids into the popout route", () => {
    expect(popoutPathForThread(thread("thread/1"))).toBe("/popout/env-1/thread%2F1");
  });
});

describe("popoutWindowFeatures", () => {
  it("offsets the new window from its opener", () => {
    expect(popoutWindowFeatures({ screenX: 100, screenY: 50 })).toContain("left=148");
    expect(popoutWindowFeatures({ screenX: 100, screenY: 50 })).toContain("top=98");
  });
});

describe("openThreadPopout", () => {
  it("opens the popout route on the current origin", () => {
    const opened: Array<{ url: string; name: string; closed: boolean }> = [];
    const { host } = makeHost(opened);

    expect(openThreadPopout(thread("a"), host)).toBe(true);
    expect(opened[0]?.url).toBe("https://app.example/popout/env-1/a");
  });

  it("puts the route in the hash where the router reads it there", () => {
    const opened: Array<{ url: string; name: string; closed: boolean }> = [];
    const { host } = makeHost(opened);

    expect(openThreadPopout(thread("e"), { ...host, hashRouting: true })).toBe(true);
    expect(opened[0]?.url).toBe("https://app.example/#/popout/env-1/e");
  });

  it("focuses the window a thread already has instead of opening a second", () => {
    const opened: Array<{ url: string; name: string; closed: boolean }> = [];
    const { host, focused } = makeHost(opened);

    openThreadPopout(thread("b"), host);
    openThreadPopout(thread("b"), host);

    expect(opened).toHaveLength(1);
    expect(focused).toHaveLength(2);
  });

  it("opens again once the popout window was closed", () => {
    const opened: Array<{ url: string; name: string; closed: boolean }> = [];
    const { host } = makeHost(opened);

    openThreadPopout(thread("c"), host);
    opened[0]!.closed = true;
    openThreadPopout(thread("c"), host);

    expect(opened).toHaveLength(2);
  });

  it("reports a blocked popup", () => {
    const blocked: ThreadPopoutHost = {
      open: () => null,
      screenX: 0,
      screenY: 0,
      origin: "https://app.example",
      hashRouting: false,
    };

    expect(openThreadPopout(thread("d"), blocked)).toBe(false);
  });
});

describe("popout locations", () => {
  it("recognizes a popout path and nothing else", () => {
    expect(isPopoutPathname(popoutPathForThread(thread("a")))).toBe(true);
    expect(isPopoutPathname("/")).toBe(false);
    expect(isPopoutPathname("/settings/snap-shot")).toBe(false);
    expect(isPopoutPathname("/env-1/a")).toBe(false);
  });
});
