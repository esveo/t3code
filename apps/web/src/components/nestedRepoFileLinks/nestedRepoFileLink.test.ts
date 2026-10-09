import { describe, expect, it } from "vite-plus/test";

import {
  needsNestedRepoFileLookup,
  resolveNestedRepoFilePath,
  type NestedRepoFileProbe,
} from "./nestedRepoFileLink";

// A workspace with two nested repositories the outer repo ignores, as in
// `dnv-proda-esveo-extension/{proda,proda-infrastructure}`.
function probeFor(paths: ReadonlyArray<string>, directories: ReadonlyArray<string>) {
  const probed: string[] = [];
  const probe: NestedRepoFileProbe = {
    pathExists: async (path) => {
      probed.push(path);
      return paths.includes(path);
    },
    listRootDirectories: async () => directories,
  };
  return { probe, probed };
}

const DIRECTORIES = ["proda", "proda-infrastructure", "docs", "node_modules"];

describe("needsNestedRepoFileLookup", () => {
  it("covers relative paths with a folder", () => {
    expect(needsNestedRepoFileLookup(".devops/delivery-pipeline.yml")).toBe(true);
    expect(needsNestedRepoFileLookup("./src/index.ts")).toBe(true);
  });

  it("leaves bare names, absolute paths and parent traversal alone", () => {
    expect(needsNestedRepoFileLookup("delivery-pipeline.yml")).toBe(false);
    expect(needsNestedRepoFileLookup("/Users/paul/x/proda/.devops/a.yml")).toBe(false);
    expect(needsNestedRepoFileLookup("C:\\repo\\a.yml")).toBe(false);
    expect(needsNestedRepoFileLookup("~/notes/a.md")).toBe(false);
    expect(needsNestedRepoFileLookup("../sibling/a.yml")).toBe(false);
  });
});

describe("resolveNestedRepoFilePath", () => {
  it("finds a file named relative to a nested repository", async () => {
    const { probe } = probeFor(["proda/.devops/delivery-pipeline.yml"], DIRECTORIES);
    await expect(resolveNestedRepoFilePath(".devops/delivery-pipeline.yml", probe)).resolves.toBe(
      "proda/.devops/delivery-pipeline.yml",
    );
  });

  it("keeps a path that exists at the workspace root without listing folders", async () => {
    const { probe, probed } = probeFor(
      [".devops/delivery-pipeline.yml", "proda/.devops/delivery-pipeline.yml"],
      DIRECTORIES,
    );
    await expect(
      resolveNestedRepoFilePath(".devops/delivery-pipeline.yml", probe),
    ).resolves.toBeNull();
    expect(probed).toEqual([".devops/delivery-pipeline.yml"]);
  });

  it("keeps the path when several nested repositories hold it", async () => {
    const { probe } = probeFor(
      ["proda/.devops/a.yml", "proda-infrastructure/.devops/a.yml"],
      DIRECTORIES,
    );
    await expect(resolveNestedRepoFilePath(".devops/a.yml", probe)).resolves.toBeNull();
  });

  it("keeps the path when no folder holds it", async () => {
    const { probe } = probeFor([], DIRECTORIES);
    await expect(resolveNestedRepoFilePath(".devops/a.yml", probe)).resolves.toBeNull();
  });
});
