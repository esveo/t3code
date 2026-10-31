import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PauseIcon, PhoneIcon, PhoneIncomingIcon, PlayIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { useScopedSettings } from "../settings/useScopedSettings";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { clearVoiceCallLevels } from "./voiceCallLevels";
import {
  isVoiceCallPeerActive,
  startVoiceCallPeer,
  stopVoiceCallPeer,
  stopVoiceCallPeerUnlessStarting,
} from "./voiceCallPeer";
import {
  canBringVoiceCallHere,
  isVoiceCallMoving,
  voiceCallClientId,
  voiceCallConnectTarget,
  voiceCallEnvironment,
} from "./voiceCallState";

const failureMessage = (failure: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "The voice call failed.";
};

const ROUND_BUTTON =
  "relative isolate flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none";
const SEND_LOOK =
  "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground";
const STAGE_LOOK =
  "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64";
const STOP_LOOK = "bg-destructive/90 text-white shadow-destructive/24 hover:bg-destructive";

interface VoiceCallButtonProps {
  environmentId: EnvironmentId;
  /** Null on a draft: a running call can be controlled there, but not started or moved to it. */
  threadId: ThreadId | null;
  primary: ReactNode;
  keepPrimary: boolean;
}

/**
 * Fork: the call controls beside the composer's primary action (hidden without a Codex
 * ChatGPT login). A call stays on its thread: elsewhere pause, resume, take over and stop
 * act on it there, and only "Call hierher holen" moves it. During the call the primary
 * action gives way to stop, unless `keepPrimary` needs it.
 */
export function VoiceCallButton(props: VoiceCallButtonProps) {
  const enabled = useScopedSettings((settings) => settings.voiceCallEnabled);
  // Stays until the peer stops: switching off ends the call, and the controls stop the peer.
  return enabled || isVoiceCallPeerActive() ? <VoiceCallControls {...props} /> : props.primary;
}

function VoiceCallControls(props: VoiceCallButtonProps) {
  const { environmentId, threadId } = props;
  const view = useEnvironmentQuery(
    voiceCallEnvironment.view({ environmentId, input: { clientId: voiceCallClientId } }),
  ).data;
  const connect = useAtomCommand(voiceCallEnvironment.connect, { reportFailure: false });
  const setTarget = useAtomCommand(voiceCallEnvironment.setTarget, { reportFailure: false });
  const hangUp = useAtomCommand(voiceCallEnvironment.hangUp, { reportFailure: false });
  const pause = useAtomCommand(voiceCallEnvironment.pause, { reportFailure: false });
  const identificationMode = useEnvironmentIdentificationMode();
  const stageVariant = useSidebarStageBackdropVariant(identificationMode === "artwork");

  const call = view?.call ?? null;
  const running = call !== null && isVoiceCallMoving(call);
  const mine = running && call.ownerClientId === voiceCallClientId;
  const paused = call?.state === "paused";

  // The server ended the call, or another client took it over.
  // oxlint-disable-next-line t3code/react-effect-budget -- syncs the WebRTC peer with the server's call state
  useEffect(() => {
    if (!mine && isVoiceCallPeerActive()) stopVoiceCallPeerUnlessStarting();
  }, [mine]);

  const moveTo =
    threadId !== null && canBringVoiceCallHere(call, voiceCallClientId, threadId) ? threadId : null;
  const targetThreadId = moveTo === null ? null : (call?.targetThreadId ?? null);
  const targetTitle = useThreadShell(
    targetThreadId === null ? null : scopeThreadRef(environmentId, targetThreadId),
  )?.title;

  const bringHere = () => {
    void setTarget({ environmentId, input: { target: moveTo } }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Call konnte nicht geholt werden",
          description: failureMessage(result),
        });
      }
    });
  };

  const end = () => {
    stopVoiceCallPeer();
    void hangUp({ environmentId, input: {} });
  };

  const start = () => {
    if (!paused) clearVoiceCallLevels();
    void startVoiceCallPeer(async (input) => {
      const result = await connect({
        environmentId,
        input: {
          clientId: voiceCallClientId,
          target: voiceCallConnectTarget(call, threadId),
          ...input,
        },
      });
      if (result._tag === "Failure") throw new Error(failureMessage(result));
      return result.value;
    }, end).catch((error: unknown) => {
      end();
      toastManager.add({
        type: "error",
        title: "Voice call failed",
        description: error instanceof Error ? error.message : "The voice call failed.",
      });
    });
  };

  const hold = () => {
    stopVoiceCallPeer();
    void pause({ environmentId, input: {} });
  };

  const availability = view?.availability ?? null;
  if (
    availability === null ||
    (threadId === null && !running && !paused) ||
    (!running &&
      !paused &&
      (availability.reason === "codex-not-logged-in" || availability.reason === "codex-api-key"))
  ) {
    return props.primary;
  }

  const connecting = mine && call?.state === "connecting";
  const label = mine
    ? "Pause voice call"
    : paused
      ? "Resume voice call"
      : running
        ? "Take over the voice call from the other device"
        : availability.available
          ? "Start voice call"
          : (availability.message ?? "Voice calls are unavailable");

  const bringHereHint = `${
    targetThreadId === null
      ? "Der Call hat noch keinen Thread"
      : `Der Call ist auf „${targetTitle ?? "einem anderen Thread"}“`
  }. Hierher holen schickt alles Weitere an diesen Thread.`;

  return (
    <>
      {moveTo !== null ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComposerControl
                size="sm"
                className="shrink-0 whitespace-nowrap"
                type="button"
                onClick={bringHere}
                aria-label={`Call hierher holen. ${bringHereHint}`}
              />
            }
          >
            <ComposerControlIcon icon={PhoneIncomingIcon} size="sm" />
            <span className="sr-only sm:not-sr-only">Call hierher holen</span>
          </TooltipTrigger>
          <TooltipPopup side="top">{bringHereHint}</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <button
            type="button"
            className={`${ROUND_BUTTON} ${stageVariant ? STAGE_LOOK : SEND_LOOK}`}
            disabled={connecting || (!mine && !availability.available)}
            onClick={mine ? hold : start}
            aria-label={label}
          >
            {stageVariant ? (
              <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
                <StageBackdropButtonArt variant={stageVariant} />
              </span>
            ) : null}
            {connecting ? (
              <Spinner size="sm" aria-hidden="true" />
            ) : mine ? (
              <PauseIcon className="size-4 fill-current" aria-hidden="true" />
            ) : paused ? (
              <PlayIcon className="size-4 fill-current" aria-hidden="true" />
            ) : (
              <PhoneIcon className="size-4" aria-hidden="true" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipPopup side="top">{call?.error && !running ? call.error : label}</TooltipPopup>
      </Tooltip>
      {mine || paused ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className={`${ROUND_BUTTON} ${STOP_LOOK}`}
                onClick={end}
                aria-label="End voice call"
              />
            }
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </TooltipTrigger>
          <TooltipPopup side="top">End voice call</TooltipPopup>
        </Tooltip>
      ) : null}
      {(mine || paused) && !props.keepPrimary ? null : props.primary}
    </>
  );
}
