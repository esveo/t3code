import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PhoneIcon } from "lucide-react";
import { useEffect } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isVoiceCallPeerActive,
  startVoiceCallPeer,
  stopVoiceCallPeer,
  stopVoiceCallPeerUnlessStarting,
} from "./voiceCallPeer";
import { voiceCallClientId, voiceCallEnvironment } from "./voiceCallState";

const failureMessage = (failure: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : "The voice call failed.";
};

/**
 * Fork: starts and ends a voice call with the thread on screen as its target
 * (Settings flag `enableVoiceCall`). Phase 1 has no call UI beyond this
 * toggle; the transcript goes to the browser console.
 */
export function VoiceCallButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  active: boolean;
}) {
  const { environmentId, threadId, active } = props;
  const view = useEnvironmentQuery(
    voiceCallEnvironment.view({ environmentId, input: { clientId: voiceCallClientId } }),
  ).data;
  const connect = useAtomCommand(voiceCallEnvironment.connect, { reportFailure: false });
  const setTarget = useAtomCommand(voiceCallEnvironment.setTarget, { reportFailure: false });
  const hangUp = useAtomCommand(voiceCallEnvironment.hangUp, { reportFailure: false });

  const call = view?.call ?? null;
  const running = call !== null && (call.state === "connecting" || call.state === "live");
  const mine = running && call.ownerClientId === voiceCallClientId;

  // The server ended the call, or another client took it over.
  useEffect(() => {
    if (!mine && isVoiceCallPeerActive()) stopVoiceCallPeerUnlessStarting();
  }, [mine]);

  // The call follows the thread on screen.
  useEffect(() => {
    if (mine && active && call.targetThreadId !== threadId) {
      void setTarget({ environmentId, input: { target: threadId } });
    }
  }, [active, call?.targetThreadId, environmentId, mine, setTarget, threadId]);

  const end = () => {
    stopVoiceCallPeer();
    void hangUp({ environmentId, input: {} });
  };

  const start = () => {
    void startVoiceCallPeer(async (input) => {
      const result = await connect({
        environmentId,
        input: { clientId: voiceCallClientId, target: threadId, ...input },
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

  const availability = view?.availability ?? null;
  if (availability === null || availability.reason === "disabled") return null;

  const label = mine
    ? "End voice call"
    : running
      ? "Take over the voice call from the other device"
      : availability.available
        ? "Start voice call"
        : (availability.message ?? "Voice calls are unavailable");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={mine}
          disabled={!mine && !availability.available}
          onPressedChange={(pressed) => (pressed ? start() : end())}
          aria-label={label}
          variant="ghost"
          size="sm"
        >
          <PhoneIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{call?.error && !running ? call.error : label}</TooltipPopup>
    </Tooltip>
  );
}
