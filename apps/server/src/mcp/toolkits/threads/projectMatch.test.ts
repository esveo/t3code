import { describe, expect, it } from "@effect/vitest";

import { matchProject } from "./projectMatch.ts";

const projects = [
  { id: "p1", title: "T3 Code", workspaceRoot: "/work/t3code" },
  { id: "p2", title: "Docs", workspaceRoot: "/work/docs/" },
  { id: "p3", title: "Website", workspaceRoot: "/work/site-a" },
  { id: "p4", title: "website", workspaceRoot: "/work/site-b" },
];

describe("matchProject", () => {
  it("finds a project by id, workspace path or title ignoring case", () => {
    expect(matchProject(projects, "p2")).toEqual({ project: projects[1] });
    expect(matchProject(projects, "/work/docs")).toEqual({ project: projects[1] });
    expect(matchProject(projects, "/work/t3code/")).toEqual({ project: projects[0] });
    expect(matchProject(projects, " t3 code ")).toEqual({ project: projects[0] });
  });

  it("lists the candidates when a title is ambiguous", () => {
    expect(matchProject(projects, "WEBSITE")).toEqual({
      error: "Several projects are titled WEBSITE; pass the id of one: Website (p3), website (p4).",
    });
  });

  it("lists every project when nothing matches", () => {
    expect(matchProject(projects, "missing")).toEqual({
      error:
        "No project matches missing. Projects: T3 Code (p1), Docs (p2), Website (p3), website (p4).",
    });
  });
});
