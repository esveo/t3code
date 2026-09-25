import { describe, expect, it } from "vite-plus/test";

import { localeLanguage } from "./localeLanguage";

describe("localeLanguage", () => {
  it("takes the language of a device locale", () => {
    expect(localeLanguage("de-DE")).toBe("de");
    expect(localeLanguage("en_US")).toBe("en");
    expect(localeLanguage("yue-Hant-HK")).toBe("yue");
  });

  it("gives up on anything that is not a language code", () => {
    expect(localeLanguage("")).toBeNull();
    expect(localeLanguage("x-private")).toBeNull();
  });
});
