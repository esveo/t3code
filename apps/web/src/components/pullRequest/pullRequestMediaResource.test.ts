import { describe, expect, it } from "vite-plus/test";

import { pullRequestMediaResource } from "./pullRequestMediaResource";

describe("pullRequestMediaResource", () => {
  it("routes GitHub media and Azure DevOps attachments through their own credential", () => {
    expect(
      pullRequestMediaResource("/repo", "https://github.com/user-attachments/assets/1a1842fb"),
    ).toEqual({
      _tag: "github-media",
      cwd: "/repo",
      url: "https://github.com/user-attachments/assets/1a1842fb",
    });
    const attachment =
      "https://dev.azure.com/ljb/proj/_apis/git/repositories/repo/pullRequests/7/attachments/a.png";
    expect(pullRequestMediaResource("/repo", attachment)).toEqual({
      _tag: "azure-devops-media",
      cwd: "/repo",
      url: attachment,
    });
  });

  it("leaves other images loading directly", () => {
    expect(pullRequestMediaResource("/repo", "https://example.com/a.png")).toBeNull();
  });
});
