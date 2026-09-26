import {
  EnvironmentId,
  type InitiativeProject,
  type InitiativeSession,
  type InitiativeSummary,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type ShellWithEnvironment, suggestedThreads, totalCost } from "./initiatives.logic";

const HOME = EnvironmentId.make("home");
const WEB = ProjectId.make("web");

const base = {
  revision: 1,
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
  createdBy: "person:robert",
  updatedBy: "person:robert",
};

const shell = (id: string, projectId = WEB) =>
  ({
    id: ThreadId.make(id),
    environmentId: HOME,
    projectId,
    title: id,
    archivedAt: null,
    updatedAt: `2026-09-26T10:0${id.length}:00.000Z`,
  }) as ShellWithEnvironment;

const project: InitiativeProject = {
  ...base,
  id: "p1",
  initiativeId: "i1",
  environmentId: null,
  projectId: WEB,
  workspaceRoot: "/repo/web",
  label: "Web",
};

const session = (
  threadId: string,
  assignment: InitiativeSession["assignment"],
): InitiativeSession => ({
  ...base,
  id: `s-${threadId}`,
  initiativeId: "i1",
  source: "t3",
  nativeId: threadId,
  environmentId: null,
  threadId: ThreadId.make(threadId),
  title: threadId,
  cwd: null,
  branch: null,
  assignment,
  launchJobId: null,
});

describe("suggestedThreads", () => {
  it("suggests project threads that no initiative holds and the user did not take out", () => {
    const elsewhere = [
      { threads: [{ environmentId: null, threadId: ThreadId.make("other") }] },
    ] as unknown as ReadonlyArray<InitiativeSummary>;
    const suggestions = suggestedThreads({
      projects: [project],
      sessions: [session("mine", "confirmed"), session("released", "released")],
      assignedElsewhere: elsewhere,
      shells: [
        shell("mine"),
        shell("released"),
        shell("other"),
        shell("fresh"),
        shell("elsewhere", ProjectId.make("docs")),
      ],
      homeEnvironmentId: HOME,
    });
    expect(suggestions.map((candidate) => candidate.id)).toEqual(["fresh"]);
  });
});

describe("totalCost", () => {
  it("sums what is known and counts what is not", () => {
    expect(
      totalCost([
        { threadId: ThreadId.make("a"), costUsd: 1.25, totalTokens: 10 },
        { threadId: ThreadId.make("b"), costUsd: null, totalTokens: null },
        { threadId: ThreadId.make("c"), costUsd: 2, totalTokens: 5 },
      ]),
    ).toEqual({ costUsd: 3.25, unknown: 1 });
  });
});
