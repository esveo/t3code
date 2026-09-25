import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useIsActiveChatPane } from "../split/chatPane";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useComposerVoiceInput } from "./useComposerVoiceInput";
import { formatVoiceElapsed, ownsVoiceInputShortcut } from "./voiceInput.logic";
import { useVoiceInputStore } from "./voiceInputStore";
import type { VoiceRecording } from "./webVoiceRecorder";

interface ComposerVoiceInputControlProps {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly insertText: (text: string) => boolean;
  /**
   * The main composer of its pane, which takes the shortcut while focus is
   * outside every composer. False for secondary ones like the subagent chat's.
   */
  readonly primary: boolean;
}

const COMPOSER_SURFACE_SELECTOR = '[data-chat-composer-surface="true"]';

function focusedComposer(): Element | null {
  return document.activeElement?.closest(COMPOSER_SURFACE_SELECTOR) ?? null;
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

  const rootRef = useRef<HTMLSpanElement>(null);
  // Without dictation there is no button, so the shortcut would record out of sight.
  const ownsShortcut = () =>
    voice.supported &&
    ownsVoiceInputShortcut({
      ownComposer: rootRef.current?.closest(COMPOSER_SURFACE_SELECTOR) ?? null,
      focusedComposer: focusedComposer(),
      isActivePane,
      isPrimaryComposer: props.primary,
    });
  const ownsShortcutRef = useRef(ownsShortcut);
  useEffect(() => {
    ownsShortcutRef.current = ownsShortcut;
  });

  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (command !== "composer.dictate" || isCommandPaletteOpen()) return;
      if (!ownsShortcutRef.current()) return;
      event.preventDefault();
      event.stopPropagation();
      // Holding the keys repeats them; only the first press toggles.
      if (!event.repeat) toggle();
    };
    window.addEventListener("keydown", onShortcut, true);
    return () => window.removeEventListener("keydown", onShortcut, true);
  }, [keybindings, toggle]);

  useEffect(() => {
    if (phase === "idle") return;
    // Bubble phase: menus, pickers and dialogs close on Escape first, and
    // mark it handled. Only an Escape nobody wanted cancels the dictation.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = focusedComposer();
      const inBody = document.activeElement === null || document.activeElement === document.body;
      if (!inBody && !focused) return;
      if (!ownsShortcutRef.current()) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [cancel, phase]);

  // An environment without dictation gets no button.
  if (!voice.supported) return null;
  return (
    <span ref={rootRef} className="contents">
      {renderControls()}
    </span>
  );

  function renderControls() {
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
