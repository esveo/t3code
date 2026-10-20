import { describe, expect, it } from "vite-plus/test";

import { lookupOriginalPosition, type RawSourceMap } from "./sourceMapLookup";
import { displaySourcePath, symbolicateStackText } from "./symbolicateStack";

// Line 1: column 0 -> ChatView.tsx 1:1 named "ChatView"; column 10 -> ChatView.tsx 3:5.
// Line 2: column 0 -> store.ts 8:3.
const map: RawSourceMap = {
  sources: ["../../src/components/ChatView.tsx", "../../src/browser/store.ts"],
  names: ["ChatView"],
  mappings: "AAAAA,UAEI;ACKF",
};

describe("lookupOriginalPosition", () => {
  it("maps a 1-based frame position to the closest preceding segment", () => {
    expect(lookupOriginalPosition(map, 1, 1)).toEqual({
      source: "../../src/components/ChatView.tsx",
      line: 1,
      column: 1,
      name: "ChatView",
    });
    expect(lookupOriginalPosition(map, 1, 15)).toEqual({
      source: "../../src/components/ChatView.tsx",
      line: 3,
      column: 5,
      name: null,
    });
    expect(lookupOriginalPosition(map, 2, 4)).toEqual({
      source: "../../src/browser/store.ts",
      line: 8,
      column: 3,
      name: null,
    });
  });

  it("finds nothing past the mapped lines", () => {
    expect(lookupOriginalPosition(map, 3, 1)).toBeNull();
  });
});

describe("symbolicateStackText", () => {
  it("rewrites bundle frames and keeps everything else", async () => {
    const requested: string[] = [];
    const text = [
      "Error: Minified React error #185",
      "    at fi (t3code://app/assets/main-abc.js:1:12)",
      "    at t3code://app/assets/main-abc.js:2:4",
      "    at Set.forEach (<anonymous>)",
      "    at r (t3code://app/assets/unmapped.js:1:1)",
    ].join("\n");

    const result = await symbolicateStackText(text, async (url) => {
      requested.push(url);
      return url.includes("main-abc") ? map : null;
    });

    expect(result).toBe(
      [
        "Error: Minified React error #185",
        "    at fi (src/components/ChatView.tsx:3:5)",
        "    at src/browser/store.ts:8:3",
        "    at Set.forEach (<anonymous>)",
        "    at r (t3code://app/assets/unmapped.js:1:1)",
      ].join("\n"),
    );
    expect(requested).toEqual([
      "t3code://app/assets/main-abc.js",
      "t3code://app/assets/unmapped.js",
    ]);
  });

  it("keeps the frame when loading its map fails", async () => {
    const frame = "    at fi (https://app.example/assets/main.js:1:1)";
    await expect(
      symbolicateStackText(frame, () => Promise.reject(new Error("offline"))),
    ).resolves.toBe(frame);
  });
});

describe("displaySourcePath", () => {
  it("shortens repo and package paths", () => {
    expect(displaySourcePath("../../src/routes/__root.tsx")).toBe("src/routes/__root.tsx");
    expect(
      displaySourcePath(
        "../../../../node_modules/.pnpm/react-dom@19.2.0/node_modules/react-dom/cjs/client.js",
      ),
    ).toBe("react-dom/cjs/client.js");
  });
});
