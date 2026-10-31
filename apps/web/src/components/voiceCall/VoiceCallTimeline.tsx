import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import type { TimelineEntry } from "../../session-logic";
import { useScopedSettings } from "../settings/useScopedSettings";
import { Button } from "../ui/button";
import {
  type DiagramData,
  runVoiceCallDiagram,
  voiceCallCaption,
  type VoiceCallSpeechHover,
} from "./voiceCallDiagram";
import { voiceCallTimeOf } from "./voiceCallLevels";
import {
  isVoiceCallMoving,
  voiceCallClientId,
  voiceCallEnvironment,
  voiceCallModelLabel,
  type VoiceCallView,
} from "./voiceCallState";

const HOVER_TEXT_WIDTH_PX = 384;
const HOVER_TEXT_MARGIN_PX = 8;

const LANES = [
  { lane: "user", className: "text-success" },
  { lane: "voice", className: "text-info" },
  { lane: "thread", className: "text-warning" },
] as const;

// ponytail: only reaches rows the virtualized list has mounted; expose its scrollToIndex if older ones matter.
const jumpToMessage = (messageId: string) =>
  document
    .querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
    ?.scrollIntoView({ block: "center" });

/** When the agent's work steps began, for the pills of the thread lane. */
const voiceCallStepTimes = (entries: ReadonlyArray<TimelineEntry>) =>
  entries.flatMap((entry) => (entry.kind === "work" ? [Date.parse(entry.createdAt)] : []));

const threadDelegations = (view: VoiceCallView, threadId: ThreadId) =>
  view.delegations.filter((delegation) => delegation.threadId === threadId);

const diagramData = (
  view: VoiceCallView,
  threadId: ThreadId,
  startedAt: number,
  stepTimes: ReadonlyArray<number>,
): DiagramData => {
  const speech = (speaker: "user" | "voice") =>
    view.transcript
      .filter((entry) => entry.speaker === speaker && (entry.endedAt === null || entry.text !== ""))
      .map((entry) => ({
        turnId: entry.turnId,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
      }));
  return {
    startedAt,
    user: speech("user"),
    voice: speech("voice"),
    blocks: threadDelegations(view, threadId).flatMap((delegation) => {
      const span = view.delegationSpans[delegation.id];
      if (span === undefined) return [];
      return {
        stepStarts: stepTimes
          .map(voiceCallTimeOf)
          .filter((at) => at > span.startedAt && (span.endedAt === null || at < span.endedAt)),
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        failed: delegation.status === "failed",
        messageId: delegation.messageId,
      };
    }),
  };
};

/** Both survive leaving the thread and opening it again, for this session. */
let closedCallId: string | null = null;
let lanesCollapsed = false;

/**
 * column-reverse pins the newest words to the bottom without measuring anything.
 * The mask counts from the bottom in px, so the newest line stays solid at any height.
 */
function VoiceCallCaption(props: { transcript: VoiceCallView["transcript"]; collapsed: boolean }) {
  const { turns, currentTurnId } = voiceCallCaption(props.transcript);
  // Collapsed, the caption is what holds the card and its button open.
  if (turns.length === 0 && !props.collapsed) return null;
  return (
    <div
      className={cn(
        "flex max-h-15 min-h-7 flex-col-reverse overflow-hidden px-3 py-1.5 text-xs leading-4 [mask-image:linear-gradient(to_top,black_22px,rgb(0_0_0/0.2)_60px)]",
        props.collapsed ? "pr-16" : "border-t border-border",
      )}
    >
      <div>
        {turns.map((entry) => (
          <p
            key={entry.turnId}
            className={entry.turnId === currentTurnId ? "text-foreground" : "text-muted-foreground"}
          >
            <span className="font-medium">{entry.speaker === "user" ? "You" : "GPT-Live"}:</span>{" "}
            {entry.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Fork: the call as lanes above the composer of the thread it talks to: the user,
 * the voice and the thread's model on one time axis that moves under a centered
 * cursor. It stays after hanging up, until it is closed.
 */
interface VoiceCallTimelineProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  modelLabel: string;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}

export function VoiceCallTimeline(props: VoiceCallTimelineProps) {
  const enabled = useScopedSettings((settings) => settings.voiceCallEnabled);
  return enabled ? <VoiceCallLanes {...props} /> : null;
}

function VoiceCallLanes(props: VoiceCallTimelineProps) {
  const { environmentId, threadId, timelineEntries } = props;
  const view = useEnvironmentQuery(
    voiceCallEnvironment.view({ environmentId, input: { clientId: voiceCallClientId } }),
  ).data;
  const [closed, setClosed] = useState(closedCallId);
  const [collapsed, setCollapsed] = useState(lanesCollapsed);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pan: number; pointer: { x: number; y: number } | null }>({
    pan: 0,
    pointer: null,
  });
  const [hover, setHover] = useState<VoiceCallSpeechHover | null>(null);
  const call = view?.call ?? null;
  const startedAt = view?.timelineStartedAt ?? null;
  const shown =
    call !== null &&
    startedAt !== null &&
    call.targetThreadId === threadId &&
    call.callId !== closed;
  const moving = call !== null && isVoiceCallMoving(call);
  // Text deltas leave this unchanged, so they do not restart the canvas.
  const dataJson =
    shown && !collapsed && view
      ? JSON.stringify(diagramData(view, threadId, startedAt, voiceCallStepTimes(timelineEntries)))
      : null;

  // oxlint-disable-next-line t3code/react-effect-budget -- drives the canvas, which is outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (dataJson === null || canvas === null || root === null) return;
    const toneOf = (name: string) => {
      const element = root.querySelector(`[data-tone="${name}"]`);
      return element === null ? "currentColor" : getComputedStyle(element).color;
    };
    const data: DiagramData = JSON.parse(dataJson);
    return runVoiceCallDiagram(canvas, {
      data,
      colors: {
        user: toneOf("user"),
        voice: toneOf("voice"),
        thread: toneOf("thread"),
        foreground: getComputedStyle(root).color,
        destructive: toneOf("destructive"),
      },
      moving,
      view: panRef.current,
      onOpenMessage: jumpToMessage,
      onHoverSpeech: setHover,
    });
  }, [dataJson, moving]);

  if (!shown || !view) return null;
  const hoveredText =
    hover === null ? "" : (view.transcript.find((e) => e.turnId === hover.turnId)?.text ?? "");

  return (
    <div
      ref={rootRef}
      role="log"
      aria-label="Voice call"
      className="relative mx-auto mb-2 w-full max-w-(--chat-content-max-width) overflow-hidden rounded-2xl border border-border bg-card text-foreground"
    >
      {collapsed ? null : (
        <div className="relative">
          {LANES.map(({ lane, className }, index) => (
            <div
              key={lane}
              className="flex h-8 items-center gap-1.5 border-t border-border px-3 first:border-t-0"
            >
              <span
                data-tone={lane}
                className={`size-1.5 shrink-0 rounded-full bg-current ${className}`}
              />
              <span className="truncate text-2xs text-muted-foreground">
                {index === 0
                  ? "You"
                  : index === 1
                    ? "GPT-Live"
                    : voiceCallModelLabel(props.modelLabel)}
              </span>
            </div>
          ))}
          <span data-tone="destructive" className="hidden text-destructive" />
          <div className="absolute inset-y-0 right-0 left-22">
            <canvas ref={canvasRef} className="block size-full" />
          </div>
        </div>
      )}
      {/* A portal, since the card clips its content. */}
      {hover === null || hoveredText === ""
        ? null
        : createPortal(
            <div
              style={{
                left: Math.min(
                  window.innerWidth - HOVER_TEXT_MARGIN_PX - HOVER_TEXT_WIDTH_PX / 2,
                  Math.max(HOVER_TEXT_MARGIN_PX + HOVER_TEXT_WIDTH_PX / 2, hover.clientX),
                ),
                bottom: window.innerHeight - hover.clientY + 4,
                maxWidth: HOVER_TEXT_WIDTH_PX,
              }}
              className="pointer-events-none fixed z-50 w-max -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md/5"
            >
              {hoveredText}
            </div>,
            document.body,
          )}
      <VoiceCallCaption transcript={view.transcript} collapsed={collapsed} />
      <div className={cn("absolute right-0.5 flex", collapsed ? "top-0" : "top-0.5")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? "Show voice call lanes" : "Hide voice call lanes"}
          aria-expanded={!collapsed}
          onClick={() => {
            lanesCollapsed = !collapsed;
            setCollapsed(!collapsed);
          }}
        >
          {collapsed ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronUpIcon className="size-3.5" />
          )}
        </Button>
        {moving || call.state === "paused" ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close voice call diagram"
            onClick={() => {
              closedCallId = call.callId;
              setClosed(call.callId);
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {/* The canvas shows these to the eye only. */}
      <div className="sr-only">
        {threadDelegations(view, threadId).map((delegation) => (
          <button
            key={delegation.id}
            type="button"
            disabled={delegation.messageId === null}
            onClick={() => {
              if (delegation.messageId !== null) jumpToMessage(delegation.messageId);
            }}
          >
            {delegation.text}
          </button>
        ))}
      </div>
    </div>
  );
}
