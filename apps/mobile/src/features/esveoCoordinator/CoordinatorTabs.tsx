/**
 * Fork: a coordinator's thread screen gets tabs, as the desktop's right panel
 * has: the chat, the threads it coordinates (Threads) and the decisions it
 * asks the user (Inbox). The home list leaves those threads out, so this tab
 * is the way to them. A thread without children or decisions shows no tabs.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { waitingDecisionCount } from "@t3tools/shared/threadInbox";
import {
  type ChildThreadState,
  resolveChildThreadState,
} from "@t3tools/shared/threadOrchestration";
import { useNavigation } from "@react-navigation/native";
import { StackActions } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThreadShells } from "../../state/entities";
import { threadListEnvironmentsAtom } from "../../state/server";
import { useThreadPr } from "../../state/use-thread-pr";
import { EsveoThreadRowContent } from "../esveoThreadRow/EsveoThreadRowContent";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { useCoordinatedThreads, useCoordinatorDecisions } from "./coordinatorState";
import { CoordinatorInbox } from "./CoordinatorInbox";

type Tab = "chat" | "threads" | "inbox";

const TAB_BAR_HEIGHT = 44;

/**
 * Mounted above the thread's chat: the tab bar sits in the flow and pushes the
 * chat down; Threads and Inbox cover the chat while open, so it stays mounted
 * with its scroll position and draft. Inbox stays mounted too, keeping
 * unsent answers across tab switches.
 */
export function CoordinatorTabs(props: { readonly threadRef: ScopedThreadRef }) {
  const threads = useThreadShells();
  const children = useCoordinatedThreads(props.threadRef, threads);
  const inbox = useCoordinatorDecisions(props.threadRef);
  const waiting = waitingDecisionCount(inbox.decisions);
  const [tab, setTab] = useState<Tab>("chat");
  const showInbox = inbox.available && inbox.decisions.length > 0;
  if (children.length === 0 && !showInbox) return null;

  const tabs: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
    { id: "chat", label: "Chat" },
    ...(children.length > 0
      ? [{ id: "threads" as const, label: `Threads ${children.length}` }]
      : []),
    ...(showInbox
      ? [{ id: "inbox" as const, label: waiting > 0 ? `Inbox ${waiting}` : "Inbox" }]
      : []),
  ];
  const active = tabs.some((entry) => entry.id === tab) ? tab : "chat";
  const overlay = {
    position: "absolute",
    top: TAB_BAR_HEIGHT,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  } as const;

  return (
    <>
      <View
        className="flex-row border-b border-border-subtle"
        style={{ height: TAB_BAR_HEIGHT }}
        accessibilityRole="tablist"
      >
        {tabs.map((entry) => {
          const selected = entry.id === active;
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setTab(entry.id)}
              className="flex-1 items-center justify-center"
              style={selected ? { borderBottomWidth: 2, borderColor: "#6ea8ff" } : undefined}
            >
              <Text
                className={cn(
                  "text-sm",
                  selected ? "font-t3-medium text-foreground" : "text-foreground-muted",
                )}
              >
                {entry.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {active === "threads" ? (
        <View className="bg-thread-canvas" style={overlay}>
          <CoordinatedThreadsList threads={children} />
        </View>
      ) : null}
      {showInbox ? (
        <View
          className="bg-thread-canvas"
          style={active === "inbox" ? overlay : { display: "none" }}
        >
          <CoordinatorInbox threadRef={props.threadRef} decisions={inbox.decisions} />
        </View>
      ) : null}
    </>
  );
}

// The screen row's classes; the badge surface only shows with an account badge, which tab rows leave out.
const TAB_ROW_APPEARANCE = {
  foregroundClassName: "text-foreground",
  mutedForegroundClassName: "text-foreground-muted",
  mutedIconTintClassName: "accent-foreground-muted",
  providerIconSurfaceColor: "transparent",
};

type GroupId = "waiting" | "working" | "review" | "active" | "settled";

const GROUP_OF_STATE: Record<ChildThreadState, GroupId | "done"> = {
  waiting: "waiting",
  failed: "waiting",
  working: "working",
  review: "review",
  stopped: "done",
  done: "done",
};

const GROUPS: ReadonlyArray<{ readonly id: GroupId; readonly label: string }> = [
  { id: "waiting", label: "Waiting on you" },
  { id: "review", label: "Ready for review" },
  { id: "working", label: "Working" },
  { id: "active", label: "Active" },
  { id: "settled", label: "Settled" },
];

/** The coordinated threads grouped like the desktop's Threads tab, newest first: what waits on the user on top. */
function CoordinatedThreadsList(props: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const groups = useMemo(() => {
    const byGroup = new Map<GroupId, EnvironmentThreadShell[]>();
    for (const thread of props.threads) {
      const group = GROUP_OF_STATE[resolveChildThreadState(thread.source)];
      const id: GroupId =
        group !== "done" ? group : thread.settledOverride === "settled" ? "settled" : "active";
      byGroup.set(id, [...(byGroup.get(id) ?? []), thread]);
    }
    return GROUPS.flatMap((group) => {
      const threads = [...(byGroup.get(group.id) ?? [])].sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
      );
      return threads.length > 0 ? [{ ...group, threads }] : [];
    });
  }, [props.threads]);

  return (
    <ScrollView className="flex-1" contentContainerClassName="pb-8">
      {groups.map((group) => {
        const folded = group.id === "settled" && !settledOpen;
        return (
          <View key={group.id}>
            <Pressable
              disabled={group.id !== "settled"}
              onPress={() => setSettledOpen((open) => !open)}
              className="px-4 pt-4 pb-1"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                {group.label} · {group.threads.length}
                {group.id === "settled" ? (folded ? "  ›" : "  ⌄") : ""}
              </Text>
            </Pressable>
            {folded
              ? null
              : group.threads.map((thread) => (
                  <CoordinatedThreadRow key={thread.id} thread={thread} />
                ))}
          </View>
        );
      })}
    </ScrollView>
  );
}

function CoordinatedThreadRow(props: { readonly thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const navigation = useNavigation();
  const { providersByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const providerInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId)(thread);
  const providerIconUrl = providersByEnvironmentId
    .get(thread.environmentId)
    ?.find(
      (provider) =>
        provider.instanceId ===
        (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
    )?.iconUrl;
  const pr = useThreadPr(thread);
  const status = resolveThreadListV2Status(thread);
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={thread.title}
      // Pushed, so Back returns to the coordinator.
      onPress={() =>
        navigation.dispatch(
          StackActions.push("Thread", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          }),
        )
      }
      className="px-4 py-2.5 active:bg-row-hover"
    >
      <EsveoThreadRowContent
        thread={thread}
        status={status}
        isUnread={isUnread}
        trailingLabel={relativeTime(thread.updatedAt ?? thread.createdAt)}
        trailingClassName="text-foreground-tertiary"
        pr={pr}
        providerInstance={providerInstance}
        providerIconUrl={providerIconUrl}
        environmentLabel={null}
        rowAppearance={TAB_ROW_APPEARANCE}
        markers={null}
        searchMatch={null}
      />
    </Pressable>
  );
}
