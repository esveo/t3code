import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useIsActiveChatPane } from "../split/chatPane";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerVoiceInput } from "./useComposerVoiceInput";
import { formatVoiceElapsed } from "./voiceInput.logic";
import { useVoiceInputStore } from "./voiceInputStore";
import type { VoiceRecording } from "./webVoiceRecorder";

interface ComposerVoiceInputControlProps {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly insertText: (text: string) => boolean;
}

/** Fork: the dictation button in the composer footer, shown when the setting is on. */
export function ComposerVoiceInputControl(props: ComposerVoiceInputControlProps) {
  const enabled = useVoiceInputStore((state) => state.enabled);
  return enabled ? <EnabledComposerVoiceInputControl {...props} /> : null;
}

function EnabledComposerVoiceInputControl(props: ComposerVoiceInputControlProps) {
  const voice = useComposerVoiceInput(props);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isActivePane = useIsActiveChatPane();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "composer.dictate");
  const { phase, toggle, cancel } = voice;

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!isActivePane) return;
      if (event.key === "Escape" && phase !== "idle") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "composer.dictate" || isCommandPaletteOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [cancel, isActivePane, keybindings, phase, toggle]);

  if (phase === "idle") {
    const label = shortcutLabel ? `Dictate (${shortcutLabel})` : "Dictate";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => void voice.start()}
              aria-label="Dictate"
            />
          }
        >
          <MicIcon />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  }

  const cancelButton = (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon-sm"
      onPointerDown={(event) => event.preventDefault()}
      onClick={cancel}
      aria-label="Cancel dictation"
    >
      <XIcon />
    </Button>
  );

  if (phase === "recording" && voice.recording) {
    return (
      <div className="flex items-center gap-1">
        {cancelButton}
        <RecordingStatus recording={voice.recording} preparationLabel={voice.preparationLabel} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => void voice.stop()}
                aria-label="Finish dictation"
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipPopup>{shortcutLabel ? `Finish (${shortcutLabel})` : "Finish"}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {cancelButton}
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <Spinner size="sm" />
        {phase === "starting"
          ? "Starting microphone…"
          : (voice.preparationLabel ?? "Transcribing…")}
      </span>
    </div>
  );
}

/**
 * Elapsed time and input level, sampled ten times a second. It lives in its own
 * component so the sampling re-renders only this pill, not the composer.
 */
function RecordingStatus(props: {
  readonly recording: VoiceRecording;
  readonly preparationLabel: string | null;
}) {
  const { recording } = props;
  const [startedAt] = useState(() => Date.now());
  const [sample, setSample] = useState({ elapsedSeconds: 0, level: 0 });
  useEffect(() => {
    const interval = setInterval(() => {
      setSample({ elapsedSeconds: (Date.now() - startedAt) / 1000, level: recording.level() });
    }, 100);
    return () => clearInterval(interval);
  }, [recording, startedAt]);

  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
      <span
        aria-hidden
        className="size-2 rounded-full bg-destructive"
        style={{ opacity: 0.35 + sample.level * 0.65, transform: `scale(${1 + sample.level})` }}
      />
      {formatVoiceElapsed(sample.elapsedSeconds)}
      {/* The first dictation records while the model is still downloading. */}
      {props.preparationLabel ? <span>· {props.preparationLabel}</span> : null}
    </span>
  );
}
