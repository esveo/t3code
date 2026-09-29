import { describe, expect, it } from "vite-plus/test";

import {
  azureDevOpsMediaFetchUrl,
  azureDevOpsMediaFileName,
  azureDevOpsMediaOrganization,
} from "./azureDevOpsMedia.ts";

const ATTACHMENT =
  "https://dev.azure.com/littlejohnbikes/d55e6e6f/_apis/git/repositories/a65e7292/pullRequests/402/attachments/CleanShot%202026-07-14%20at%2017.16.53.png";

describe("azureDevOpsMediaFetchUrl", () => {
  it("recognizes pull request attachments and drops query and fragment", () => {
    expect(azureDevOpsMediaFetchUrl(`${ATTACHMENT}?api-version=7.1#x`)).toBe(ATTACHMENT);
  });

  it("leaves everything else loading directly", () => {
    for (const source of [
      ATTACHMENT.replace("https:", "http:"),
      ATTACHMENT.replace("dev.azure.com", "evil.example"),
      "https://dev.azure.com/littlejohnbikes/d55e6e6f/_git/repo/pullrequest/402",
      "https://dev.azure.com/littlejohnbikes/d55e6e6f/_apis/git/repositories/a65e7292/items?path=/a.png",
      "not a url",
    ]) {
      expect(azureDevOpsMediaFetchUrl(source)).toBeNull();
    }
  });
});

describe("azureDevOpsMediaOrganization and azureDevOpsMediaFileName", () => {
  it("read the organization and a readable file name", () => {
    expect(azureDevOpsMediaOrganization(ATTACHMENT)).toBe("littlejohnbikes");
    expect(azureDevOpsMediaFileName(ATTACHMENT)).toBe("CleanShot 2026-07-14 at 17.16.53.png");
  });
});
