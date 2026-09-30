/**
 * Fork: the Android home list row in the desktop's Threads-panel look. A status
 * dot, the title on one line, then provider, model and branch; time or status
 * and the pull request sit on the right. Replaces the upstream card content
 * (project line, two-line title, monospace branch) on Android phones only.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { formatModelSlugName } from "@t3tools/shared/model";
import type { ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { useThreadPr } from "../../state/use-thread-pr";
import type { getThreadListV2RowAppearance } from "../threads/thread-list-v2-row-appearance";
import type { ThreadRowProviderInstance } from "../threads/thread-provider-instance";
import type { ThreadListV2Status } from "../threads/threadListV2";

type RowAppearance = Pick<
  ReturnType<typeof getThreadListV2RowAppearance>,
  | "foregroundClassName"
  | "mutedForegroundClassName"
  | "mutedIconTintClassName"
  | "providerIconSurfaceColor"
>;
type ThreadPr = NonNullable<ReturnType<typeof useThreadPr>>;

// The same hues as the status labels: amber approval, indigo input, sky working.
const DOT_COLOR: Partial<Record<ThreadListV2Status, string>> = {
  approval: "#f59e0b",
  input: "#818cf8",
  working: "#38bdf8",
  failed: "#f43f5e",
  limited: "#f59e0b",
};
const UNREAD_DOT = "#34d399";
const IDLE_DOT = "#6b7280";

export function EsveoThreadRowContent(props: {
  readonly thread: EnvironmentThreadShell;
  readonly status: ThreadListV2Status;
  readonly isUnread: boolean;
  /** Status label or the time, as the upstream row shows it. */
  readonly trailingLabel: string;
  readonly trailingClassName: string;
  readonly pr: ThreadPr | null;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly providerIconUrl: string | undefined;
  readonly environmentLabel: string | null;
  readonly rowAppearance: RowAppearance;
  /** Queued and pinned glyphs of the upstream row. */
  readonly markers: ReactNode;
  readonly searchMatch: ReactNode;
}) {
  const { thread, rowAppearance } = props;
  const model = formatModelSlugName(thread.modelSelection.model);
  const error =
    (props.status === "failed" || props.status === "limited") && thread.runtime?.lastError
      ? thread.runtime.lastError
      : null;
  const dotColor = DOT_COLOR[props.status] ?? (props.isUnread ? UNREAD_DOT : IDLE_DOT);
  const details = [model, thread.branch, props.environmentLabel].filter(Boolean);

  return (
    <View className="flex-row items-center gap-3">
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
      <View className="min-w-0 flex-1">
        <Text
          className={cn("text-base font-t3-medium", rowAppearance.foregroundClassName)}
          numberOfLines={1}
        >
          {thread.title}
        </Text>
        {props.searchMatch}
        {error ? (
          <Text
            className={cn(
              "mt-0.5 text-xs",
              props.status === "limited" ? "text-warning-foreground" : "text-danger-foreground",
            )}
            numberOfLines={1}
          >
            {error}
          </Text>
        ) : (
          <View className="mt-0.5 flex-row items-center gap-1">
            {props.providerInstance ? (
              <ProviderInstanceIcon
                iconUrl={props.providerIconUrl}
                provider={props.providerInstance.driverKind}
                size={12}
                displayName={props.providerInstance.displayName}
                accentColor={props.providerInstance.accentColor}
                showBadge={false}
                surfaceColor={rowAppearance.providerIconSurfaceColor}
              />
            ) : null}
            <Text
              className={cn("shrink text-xs", rowAppearance.mutedForegroundClassName)}
              numberOfLines={1}
            >
              {details.join("  ·  ")}
            </Text>
          </View>
        )}
      </View>
      <View className="items-end gap-1">
        <View className="flex-row items-center gap-1">
          {props.markers}
          <Text className={cn("text-xs tabular-nums", props.trailingClassName)}>
            {props.trailingLabel}
          </Text>
        </View>
        {props.pr ? (
          <View
            className="flex-row items-center gap-1"
            accessibilityLabel={props.pr.accessibilityLabel}
          >
            <SymbolView
              name={props.pr.kind === "stack" ? "square.3.layers.3d" : "arrow.triangle.pull"}
              size={11}
              tintColorClassName={
                props.pr.state === null || props.pr.isDraft
                  ? rowAppearance.mutedIconTintClassName
                  : props.pr.state === "open"
                    ? "accent-adaptive-emerald-600-400"
                    : props.pr.state === "closed"
                      ? "accent-adaptive-rose-600-400"
                      : "accent-adaptive-violet-600-400"
              }
            />
            <Text className={cn("text-xs tabular-nums", props.pr.textClassName)}>
              {props.pr.label}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
