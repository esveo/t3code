import type { AnyRouter } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  inApp: true,
  toast: vi.fn<(toast: { actionProps: { onClick: () => void } }) => string>(() => "toast-1"),
  close: vi.fn(),
  navigate: vi.fn(),
  reveal: vi.fn(() => true),
  settingsListeners: new Set<() => void>(),
}));

vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.close,
    },
  };
});
vi.mock(import("./split/splitPanes"), async (original) => ({
  ...(await original()),
  revealThreadInSplit: state.reveal,
}));
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: "off" as ClientSettings["notificationMode"],
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);

function thread(approval: boolean) {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: "run-1",
    status: "running",
    pendingRuntimeRequest: approval ? { id: "request-1", kind: "command", createdAt: NOW } : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    latestRunRequestedAt: NOW,
    latestRunStartedAt: NOW,
    latestRunCompletedAt: undefined,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(approval: boolean) {
  return {
    status: "live",
    snapshot: Option.some({
      projects: [{ id: "project-1", title: "Webshop", workspaceRoot: "/src/webshop" }],
      threads: [thread(approval)],
    }),
  };
}

function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  registry.set(environmentIdsAtom, ["env-1"]);
  registry.set(shellAtom("env-1"), shell(false));
  state.settingsListeners.clear();
  state.inApp = true;
  stack.use(vi.spyOn(document, "hasFocus").mockReturnValue(true));
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"));
  const router = {
    state: { matches: [{ params: { environmentId: "env-1", threadId: "other-thread" } }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  stack.defer(startThreadNotifications(registry, router));
  return {
    requestApproval: () => registry.set(shellAtom("env-1"), shell(true)),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it("shows the thread and project identity for an approval", async () => {
  await using app = setup();
  app.requestApproval();
  expect(state.toast).toHaveBeenCalledTimes(1);
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Fix the login form",
      description: "Approval needed · Webshop",
    }),
  );
});

it("opens a notification in the split when possible", async () => {
  await using app = setup();
  app.requestApproval();
  const toast = state.toast.mock.calls[0]![0];
  toast.actionProps.onClick();
  expect(state.reveal).toHaveBeenCalledWith(
    { environmentId: "env-1", threadId: "thread-1" },
    { environmentId: "env-1", threadId: "other-thread" },
  );
  expect(state.navigate).not.toHaveBeenCalled();
});
