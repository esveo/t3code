import { describe, expect, it } from "vite-plus/test";

import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("keeps the default palette on Uniwind's built-in appearance themes", () => {
    expect(getMobileUniwindThemeName("t3-code", "light")).toBe("light");
    expect(getMobileUniwindThemeName("t3-code", "dark")).toBe("dark");
  });

  it("maps custom palettes and appearances to registered themes", () => {
    expect(getMobileUniwindThemeName("t3-chat", "dark")).toBe("t3-chat-dark");
  });

  it("hydrates text variables and clears the native appearance override", () => {
    const operations = createMobileThemeRuntimeOperations(null, initialState);
    const variableOperations = operations.filter(
      (operation) => operation.kind === "update-text-variables",
    );

    // Fork: 12 upstream themes + 4 esveo themes.
    expect(variableOperations).toHaveLength(16);
    // Fork: esveo palettes come last.
    expect(variableOperations.at(-1)?.themeName).toBe("esveo-midnight-dark");
    expect(operations.at(-1)).toEqual({
      kind: "set-appearance-mode",
      appearance: "light",
      themeMode: "system",
    });
  });

  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });

  it("updates native appearance once when the selected mode changes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
      themeMode: "dark",
    });

    expect(operations).toEqual([
      {
        kind: "set-appearance-mode",
        appearance: "dark",
        themeMode: "dark",
      },
    ]);
  });

  it("updates text variables for every theme without switching palettes", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      baseFontSize: 18,
    });

    // Fork: 12 upstream themes + 4 esveo themes.
    expect(operations).toHaveLength(16);
    expect(operations.every((operation) => operation.kind === "update-text-variables")).toBe(true);
    expect(operations.at(-1)).toMatchObject({
      kind: "update-text-variables",
      themeName: "esveo-midnight-dark", // Fork: esveo palettes come last.
    });
  });

  it("does no native work when persistence echoes an already-applied state", () => {
    expect(createMobileThemeRuntimeOperations(initialState, initialState)).toEqual([]);
  });
});
