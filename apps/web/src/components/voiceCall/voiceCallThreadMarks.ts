/**
 * Fork: "Voice call started/ended" in the chat, as entries the timeline draws like
 * a compaction divider. They carry no run, so they stay out of turn folds and of
 * everything the agent sees.
 */
import type { ScopedThreadRef, VoiceCallThreadSpan } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { useEnvironmentQuery, useEnvironmentQuerySelector } from "~/state/query";
import type { TimelineEntry } from "../../session-logic";
import { useScopedSettings } from "../settings/useScopedSettings";
import { formatDuration } from "../agentTime/agentTimeChart";
import { voiceCallClientId, voiceCallEnvironment, type VoiceCallView } from "./voiceCallState";

const MARK_ID_PREFIX = "voice-call-mark:";

export const isVoiceCallMarkId = (id: string) => id.startsWith(MARK_ID_PREFIX);

const markEntry = (kind: string, atMs: number, label: string): TimelineEntry => {
  const createdAt = new Date(atMs).toISOString();
  const id = `${MARK_ID_PREFIX}${kind}:${atMs}`;
  return {
    id,
    kind: "work",
    createdAt,
    entry: {
      id,
      createdAt,
      label,
      tone: "info",
      sourceActivityKind: "context-compaction",
    },
  };
};

export const voiceCallMarkEntries = (spans: ReadonlyArray<VoiceCallThreadSpan>) =>
  spans.flatMap((span) => [
    markEntry("started", span.startedAt, "Voice call started"),
    ...(span.endedAt === null
      ? []
      : [
          markEntry(
            "ended",
            span.endedAt,
            `Voice call ended · ${formatDuration((span.endedAt - span.startedAt) / 1_000)}`,
          ),
        ]),
  ]);

export const withVoiceCallMarks = (
  entries: ReadonlyArray<TimelineEntry>,
  spans: ReadonlyArray<VoiceCallThreadSpan>,
): ReadonlyArray<TimelineEntry> => {
  if (spans.length === 0) return entries;
  const merged = [...entries];
  for (const mark of voiceCallMarkEntries(spans)) {
    const at = merged.findIndex((entry) => entry.createdAt > mark.createdAt);
    merged.splice(at === -1 ? merged.length : at, 0, mark);
  }
  return merged;
};

const callKey = (result: AsyncResult.AsyncResult<VoiceCallView, unknown>) => {
  const call = Option.getOrNull(AsyncResult.value(result))?.call ?? null;
  return call === null
    ? null
    : `${call.callId}:${call.segmentId}:${call.targetThreadId}:${call.state}`;
};

/** Selects a key rather than the view, since the view changes with every spoken word. */
export function useVoiceCallMarks(
  threadRef: ScopedThreadRef | null,
  entries: ReadonlyArray<TimelineEntry>,
) {
  const enabled = useScopedSettings((settings) => settings.voiceCallEnabled);
  const ref = enabled ? threadRef : null;
  const environmentId = ref?.environmentId ?? null;
  const { data: spans, refresh } = useEnvironmentQuery(
    ref === null
      ? null
      : voiceCallEnvironment.threadSpans({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
  );
  const key = useEnvironmentQuerySelector(
    environmentId === null
      ? null
      : voiceCallEnvironment.view({ environmentId, input: { clientId: voiceCallClientId } }),
    callKey,
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- the server's spans move with the call, which only the subscription reports
  useEffect(() => {
    if (key !== null) refresh();
  }, [key, refresh]);
  return enabled ? withVoiceCallMarks(entries, spans ?? []) : entries;
}
