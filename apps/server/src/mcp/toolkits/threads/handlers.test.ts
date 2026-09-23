// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { parseTaggedThreadMessage } from "@t3tools/shared/threadOrchestration";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ThreadsToolkitHandlersLive } from "./handlers.ts";
import { ThreadsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const COORDINATOR_ID = ThreadId.make("coordinator");
const CHILD_ID = ThreadId.make("child");

let uuidCounter = 0;
const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-threads-toolkit-"));
const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(171),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function makeThread(overrides: Partial<OrchestrationThreadShell>): OrchestrationThreadShell {
  return {
    id: COORDINATOR_ID,
    projectId: PROJECT_ID,
    title: "2.0 audit",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "release/2.0",
    worktreePath: "/workspace/project",
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
};

const otherProject: OrchestrationProjectShell = {
  ...project,
  id: ProjectId.make("project-2"),
  title: "Docs site",
  workspaceRoot: "/workspace/docs",
};

const makeHarness = Effect.fn("makeThreadsToolkitHarness")(function* (
  options: {
    readonly enabled?: boolean;
    readonly caller?: OrchestrationThreadShell;
    readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
    readonly messages?: Readonly<Record<string, ReadonlyArray<OrchestrationMessage>>>;
    readonly branches?: ReadonlyArray<{ name: string; isRemote?: boolean; remoteName?: string }>;
  } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const caller = options.caller ?? makeThread({});
  const threads = [caller, ...(options.threads ?? [])];
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  // The config layer comes first so the test crypto below replaces the real one.
  const dependencies = Layer.mergeAll(
    configLayer,
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threads.find((thread) => thread.id === threadId))),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
      getProjectShells: () => Effect.succeed([project, otherProject]),
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 0, projects: [project], threads, updatedAt: "" }),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          options.messages?.[threadId]
            ? Option.some({ messages: options.messages[threadId] } as never)
            : Option.none(),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(GitWorkflowService)({
      isRepository: () => Effect.succeed(true),
      hasCommit: (input) =>
        Effect.succeed(
          !options.branches || options.branches.some((branch) => branch.name === input.refName),
        ),
      listRefs: () =>
        Effect.succeed({
          refs: (options.branches ?? []).map((branch) => ({
            ...branch,
            current: false,
            isDefault: false,
            worktreePath: null,
          })),
          isRepo: true,
          hasPrimaryRemote: true,
          nextCursor: null,
          totalCount: options.branches?.length ?? 0,
        }),
      createWorktree: (input) =>
        Effect.succeed({
          worktree: { path: `/worktrees/${input.newRefName}`, refName: input.newRefName! },
        } as never),
    }),
    Layer.mock(ProjectSetupScriptRunner)({
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    ServerSettings.layerTest({ enableThreadOrchestration: options.enabled ?? true }),
    Layer.succeed(Crypto.Crypto, {
      ...testCrypto,
      randomUUIDv4: Effect.sync(() => `uuid-${++uuidCounter}`),
    } satisfies typeof testCrypto),
  );
  const toolkit = yield* ThreadsToolkit.pipe(
    Effect.provide(ThreadsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ThreadsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ThreadsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: caller.id,
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests", "threads"]),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  /** The worktree runs after start_thread returns; its mocks resolve within a few yields. */
  const settle = Effect.repeat(Effect.yieldNow, { times: 20 });
  const { attachmentsDir } = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
  return { commands, call, settle, attachmentsDir };
});

function userMessage(overrides: Partial<OrchestrationMessage>): OrchestrationMessage {
  return {
    id: MessageId.make("message-1"),
    role: "user",
    text: "See attached.",
    turnId: null,
    streaming: false,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z",
    ...overrides,
  };
}

const types = (commands: ReadonlyArray<OrchestrationCommand>) => commands.map((c) => c.type);

describe("threads toolkit", () => {
  it.effect("starts a thread in the coordinator's checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("start_thread", {
        title: "Fix cold start",
        prompt: "Measure the cold start.",
        worktree: false,
      });
      const commands = yield* Ref.get(harness.commands);
      expect(types(commands)).toEqual(["thread.create", "thread.turn.start"]);
      const create = commands[0] as Extract<OrchestrationCommand, { type: "thread.create" }>;
      expect(create).toMatchObject({
        parentThreadId: COORDINATOR_ID,
        projectId: PROJECT_ID,
        title: "Fix cold start",
        branch: "release/2.0",
        worktreePath: "/workspace/project",
      });
      const turn = commands[1] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
      expect(parseTaggedThreadMessage(turn.message.text)).toMatchObject({
        tag: "t3_from_coordinator",
        threadId: COORDINATOR_ID,
        body: "Measure the cold start.",
      });
      expect(result).toMatchObject({ worktree: false, branch: "release/2.0" });
      expect(result.link).toBe(`[Fix cold start](t3-thread:${create.threadId})`);
    }),
  );

  it.effect("prepares its own worktree and then starts the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("start_thread", {
        title: "Harden checkout",
        prompt: "Trace the retries.",
      });
      yield* harness.settle;
      const commands = yield* Ref.get(harness.commands);
      expect(types(commands)).toEqual([
        "thread.create",
        "thread.message.user.append",
        "thread.session.set",
        "thread.meta.update",
        "thread.turn.start",
      ]);
      expect(result).toMatchObject({ worktree: true, branch: "t3code/abababab" });
      expect(commands[3]).toMatchObject({
        branch: "t3code/abababab",
        worktreePath: "/worktrees/t3code/abababab",
      });
      const append = commands[1] as Extract<
        OrchestrationCommand,
        { type: "thread.message.user.append" }
      >;
      const turn = commands[4] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
      // The turn references the task already shown, so it is not sent twice.
      expect(turn.message.messageId).toBe(append.message.messageId);
    }),
  );

  it.effect("starts a thread in another project from that project's checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const projects = yield* harness.call("list_projects", {});
      expect(projects.projects.map((p) => [p.projectId, p.current])).toEqual([
        ["project-1", true],
        ["project-2", false],
      ]);
      const result = yield* harness.call("start_thread", {
        title: "Update docs",
        prompt: "Document the new flag.",
        project: "/workspace/docs/",
        worktree: false,
      });
      const create = (yield* Ref.get(harness.commands))[0] as Extract<
        OrchestrationCommand,
        { type: "thread.create" }
      >;
      // The coordinator's branch belongs to its own repository, not this one.
      expect(create).toMatchObject({
        projectId: "project-2",
        parentThreadId: COORDINATOR_ID,
        branch: null,
        worktreePath: null,
      });
      expect(result.branch).toBe(null);

      const error = yield* harness
        .call("start_thread", { title: "Nowhere", prompt: "x", project: "missing" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ThreadOrchestrationFailedError" });
    }),
  );

  it.effect("stays off until the user turns it on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ enabled: false });
      const error = yield* harness.call("list_threads", {}).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ThreadOrchestrationDisabledError" });
    }),
  );

  it.effect("a child cannot start threads of its own", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: makeThread({ id: CHILD_ID, parentThreadId: COORDINATOR_ID }),
      });
      const error = yield* harness
        .call("start_thread", { title: "Nested", prompt: "Nope." })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ThreadOrchestrationNestedError" });
    }),
  );

  it.effect("lists and messages only the coordinator's own children", () =>
    Effect.gen(function* () {
      const child = makeThread({
        id: CHILD_ID,
        title: "Load test",
        parentThreadId: COORDINATOR_ID,
        session: { status: "running" } as OrchestrationThreadShell["session"],
      });
      const stranger = makeThread({ id: ThreadId.make("stranger"), title: "Other" });
      const harness = yield* makeHarness({ threads: [child, stranger] });

      const listed = yield* harness.call("list_threads", {});
      expect(listed.threads.map((thread) => [thread.threadId, thread.state])).toEqual([
        [CHILD_ID, "working"],
      ]);

      yield* harness.call("send_to_thread", { threadId: CHILD_ID, message: "Also run 10k." });
      const error = yield* harness
        .call("send_to_thread", { threadId: "stranger", message: "Hi" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ChildThreadNotFoundError" });
      expect(types(yield* Ref.get(harness.commands))).toEqual(["thread.turn.start"]);
    }),
  );

  it.effect("hands local files and stored attachments to a new thread", () =>
    Effect.gen(function* () {
      const probe = yield* makeHarness();
      const storedId = "coordinator-00000000-0000-4000-8000-0000000000aa-pdf";
      NodeFS.writeFileSync(NodePath.join(probe.attachmentsDir, `${storedId}.pdf`), "%PDF-1.7");
      const localFile = NodePath.join(baseDir, "2026-09-21 14-25-22.txt");
      NodeFS.writeFileSync(localFile, "boot log");
      const harness = yield* makeHarness({
        messages: {
          [COORDINATOR_ID]: [
            userMessage({
              attachments: [
                {
                  type: "file",
                  id: storedId,
                  name: "Angebot.pdf",
                  mimeType: "application/pdf",
                  sizeBytes: 8,
                },
              ],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    kind: "file",
                    contextId: "file_offer",
                    label: "Angebot.pdf",
                    attachmentId: storedId,
                    name: "Angebot.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 8,
                  },
                ],
              } as never,
            }),
          ],
        },
      });
      yield* harness.call("start_thread", {
        title: "Analyse logs",
        prompt: "Compare the two runs.",
        worktree: false,
        attachments: [{ path: localFile }, { attachmentId: "file_offer" }],
      });
      const turn = (yield* Ref.get(harness.commands))[1] as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      expect(
        turn.message.attachments.map((a) => [a.type, a.name, a.mimeType, a.sizeBytes]),
      ).toEqual([
        ["file", "2026-09-21 14-25-22.txt", "text/plain", 8],
        ["file", "Angebot.pdf", "application/pdf", 8],
      ]);
      // Each is a copy owned by the new thread, as if uploaded there.
      for (const attachment of turn.message.attachments) {
        expect(attachment.id.startsWith(`${turn.threadId}-`)).toBe(true);
      }
      const copied = NodeFS.readdirSync(harness.attachmentsDir).filter((file) =>
        file.startsWith(`${turn.threadId}-`),
      );
      expect(copied.toSorted()).toHaveLength(2);
    }),
  );

  it.effect("refuses attachments it cannot hand over, before creating anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const attachment of [
        { path: "relative/log.txt" },
        { path: NodePath.join(baseDir, "missing.txt") },
        { attachmentId: "file_unknown" },
        {},
      ]) {
        const error = yield* harness
          .call("start_thread", { title: "x", prompt: "x", attachments: [attachment] })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ThreadOrchestrationFailedError" });
      }
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("sends attachments with a message and lists them in read_thread", () =>
    Effect.gen(function* () {
      const child = makeThread({
        id: CHILD_ID,
        title: "Load test",
        parentThreadId: COORDINATOR_ID,
      });
      const chart = NodePath.join(baseDir, "chart.png");
      NodeFS.writeFileSync(chart, "png");
      const harness = yield* makeHarness({
        threads: [child],
        messages: {
          [CHILD_ID]: [
            userMessage({
              attachments: [
                {
                  type: "file",
                  id: "child-00000000-0000-4000-8000-0000000000bb-txt",
                  name: "results.txt",
                  mimeType: "text/plain",
                  sizeBytes: 3,
                },
              ],
            }),
          ],
        },
      });
      yield* harness.call("send_to_thread", {
        threadId: CHILD_ID,
        message: "Here is the chart.",
        attachments: [{ path: chart, name: "latency.png" }],
      });
      const turn = (yield* Ref.get(harness.commands))[0] as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      expect(turn.message.attachments).toMatchObject([
        { type: "image", name: "latency.png", mimeType: "image/png" },
      ]);

      const read = yield* harness.call("read_thread", { threadId: CHILD_ID });
      expect(read.attachments).toEqual([
        {
          messageId: "message-1",
          role: "user",
          attachmentId: "child-00000000-0000-4000-8000-0000000000bb-txt",
          type: "file",
          name: "results.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          path: NodePath.join(
            harness.attachmentsDir,
            "child-00000000-0000-4000-8000-0000000000bb-txt.txt",
          ),
        },
      ]);
    }),
  );

  it.effect("names close branches when baseBranch does not resolve", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        branches: [
          { name: "main" },
          { name: "feat/financial-facts-v2" },
          { name: "origin/feat/financial-facts-v2", isRemote: true, remoteName: "origin" },
        ],
      });
      const error = yield* harness
        .call("start_thread", { title: "x", prompt: "x", baseBranch: "financial-facts-v2" })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        "financial-facts-v2 is not a commit in this repository. Did you mean: feat/financial-facts-v2, origin/feat/financial-facts-v2?",
      );
    }),
  );
});
