import { describe, expect, it } from "vite-plus/test";

import { isThreadPopoutUrl, resolvePopoutWindowOptions } from "./popoutWindow.ts";

const APPLICATION_URL = "t3code://app/";

describe("isThreadPopoutUrl", () => {
  it("accepts the popout route on the application origin", () => {
    expect(
      isThreadPopoutUrl({
        applicationUrl: APPLICATION_URL,
        targetUrl: "t3code://app/popout/env-1/thread-1",
      }),
    ).toBe(true);
  });

  it("accepts the popout route in the hash, which is how the desktop routes", () => {
    expect(
      isThreadPopoutUrl({
        applicationUrl: APPLICATION_URL,
        targetUrl: "t3code://app/#/popout/env-1/thread-1",
      }),
    ).toBe(true);
  });

  it("rejects another scheme or host with the same opaque origin", () => {
    expect(
      isThreadPopoutUrl({
        applicationUrl: APPLICATION_URL,
        targetUrl: "t3code-dev://app/#/popout/env-1/thread-1",
      }),
    ).toBe(false);
    expect(
      isThreadPopoutUrl({
        applicationUrl: APPLICATION_URL,
        targetUrl: "t3code://elsewhere/#/popout/env-1/thread-1",
      }),
    ).toBe(false);
  });

  it("rejects other paths and other origins", () => {
    expect(
      isThreadPopoutUrl({ applicationUrl: APPLICATION_URL, targetUrl: "t3code://app/settings" }),
    ).toBe(false);
    expect(
      isThreadPopoutUrl({ applicationUrl: APPLICATION_URL, targetUrl: "t3code://app/#/settings" }),
    ).toBe(false);
    expect(
      isThreadPopoutUrl({
        applicationUrl: APPLICATION_URL,
        targetUrl: "https://example.com/popout/env-1/thread-1",
      }),
    ).toBe(false);
    expect(isThreadPopoutUrl({ applicationUrl: APPLICATION_URL, targetUrl: "not a url" })).toBe(
      false,
    );
  });
});

describe("resolvePopoutWindowOptions", () => {
  const base = {
    backgroundColor: "#111111",
    preloadPath: "/preload.js",
    title: "T3 Code",
  };

  it("takes size and position from the features string", () => {
    const options = resolvePopoutWindowOptions({
      ...base,
      features: "popup=yes,width=900,height=760,left=148,top=98",
    });

    expect(options).toMatchObject({ width: 900, height: 760, x: 148, y: 98 });
    expect(options.webPreferences?.preload).toBe("/preload.js");
  });

  it("falls back to defaults and never goes below the minimum size", () => {
    const options = resolvePopoutWindowOptions({ ...base, features: "popup=yes,width=10" });

    expect(options.width).toBe(520);
    expect(options.height).toBe(760);
    expect(options.x).toBeUndefined();
  });
});
