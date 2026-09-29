/**
 * Fork: the composer of a provider subagent thread. Only the parent agent can
 * reach the subagent, so a message typed here goes to the parent thread as a
 * user message asking it to pass it on. Stop ends the running subagent where
 * its provider supports that. It wears the chat composer's surface, footer and
 * send/stop buttons; the model is shown where the composer's picker sits, but
 * the provider chose it, so it is read-only.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { ArrowUpLeftIcon } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ComposerControl, ComposerControlSeparator } from "~/components/chat/ComposerControl";
import { ComposerPrimaryActions } from "~/components/chat/ComposerPrimaryActions";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import type { ProviderSubagentBar } from "~/components/chat/ProviderSubagentBar";
import { newMessageId } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildSubagentRelayMessage } from "./subagentRelay.logic";
import { subagentRelayEnvironment } from "./subagentRelayState";

const PLACEHOLDER = "Message the subagent through its parent";
const noop = () => {};

export function SubagentRelayBar(
  props: ComponentProps<typeof ProviderSubagentBar> & {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  },
) {
  const { environmentId, threadId, provider, modelLabel, effortLabel, status, onOpenParent } =
    props;
  const target = useEnvironmentQuery(
    subagentRelayEnvironment.target({ environmentId, input: { threadId } }),
  ).data;
  const parentRef = useMemo(
    () => (target === null ? null : scopeThreadRef(environmentId, target.parentThreadId)),
    [environmentId, target],
  );
  const parent = useThreadShell(parentRef);
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const stop = useAtomCommand(subagentRelayEnvironment.stop);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  const hasText = text.trim().length > 0;

  const send = useCallback(async () => {
    if (target === null || parent === null || sending || !hasText) return;
    setSending(true);
    const result = await startTurn({
      environmentId,
      input: {
        threadId: target.parentThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildSubagentRelayMessage(target, text),
          attachments: [],
        },
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
    setSending(false);
    if (result._tag === "Success") setText("");
  }, [environmentId, hasText, parent, sending, startTurn, target, text]);

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void send();
    },
    [send],
  );

  const onStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    await stop({ environmentId, input: { threadId } });
    setStopping(false);
  }, [environmentId, stop, stopping, threadId]);

  // Like the composer: an empty prompt on running work offers Stop, text offers Send.
  const showStop = live && target !== null && target.supportsStop && !hasText;

  return (
    <form onSubmit={onSubmit}>
      <ComposerSurface.Main>
        <div className="rounded-3xl">
          {target === null ? null : (
            <div className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
              <div className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm)) max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)">
                <textarea
                  value={text}
                  rows={1}
                  placeholder={PLACEHOLDER}
                  aria-label={PLACEHOLDER}
                  className="-m-1 block field-sizing-content max-h-52 min-h-19.5 w-[calc(100%+0.5rem)] resize-none overflow-y-auto bg-transparent p-1 leading-relaxed text-foreground placeholder:text-placeholder/75 focus:outline-none"
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
              </div>
            </div>
          )}
          <div
            className={
              target === null
                ? "flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 py-2 sm:px-4"
                : "flex min-w-0 flex-nowrap items-center justify-between gap-2 px-3 pb-3 sm:px-4 sm:pb-4"
            }
          >
            <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <SubagentModel provider={provider} modelLabel={modelLabel} />
              {effortLabel === null ? null : (
                <>
                  <ComposerControlSeparator />
                  <span className="inline-flex h-7 shrink-0 items-center px-2.5 font-medium text-base text-secondary-label sm:text-sm">
                    {effortLabel}
                  </span>
                </>
              )}
              {onOpenParent ? (
                <>
                  <ComposerControlSeparator />
                  <ComposerControl onClick={onOpenParent}>
                    <ArrowUpLeftIcon />
                    Open parent
                  </ComposerControl>
                </>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
              <SubagentStatus
                status={status}
                modelDescription={
                  effortLabel === null ? modelLabel : `${modelLabel}, ${effortLabel}`
                }
              />
              {target === null ? null : (
                <ComposerPrimaryActions
                  compact={false}
                  pendingAction={null}
                  isRunning={showStop}
                  showPlanFollowUpPrompt={false}
                  promptHasText={hasText}
                  isSendBusy={sending}
                  sendDisabledReason={parent === null ? "Loading the parent thread" : null}
                  isConnecting={false}
                  isEnvironmentUnavailable={false}
                  isPreparingWorktree={false}
                  hasSendableContent={hasText}
                  onPreviousPendingQuestion={noop}
                  onInterrupt={() => void onStop()}
                  onImplementPlanInNewThread={noop}
                />
              )}
            </div>
          </div>
        </div>
      </ComposerSurface.Main>
    </form>
  );
}

/** Where the composer shows its model picker; the provider picked this model. */
function SubagentModel(props: {
  readonly provider: ComponentProps<typeof ProviderSubagentBar>["provider"];
  readonly modelLabel: string;
}) {
  return (
    <span className="inline-flex h-7 min-w-0 shrink items-center gap-1.5 px-2.5 font-medium text-base text-secondary-label sm:text-sm">
      {props.provider ? (
        <ProviderInstanceIcon
          driverKind={props.provider.driverKind}
          displayName={props.provider.displayName}
          accentColor={props.provider.accentColor}
          acpRegistryAgentId={props.provider.acpRegistryAgentId}
          acpRegistryIconUrl={props.provider.acpRegistryIconUrl}
          className="size-4 shrink-0"
          iconClassName="size-4"
        />
      ) : null}
      <span className="min-w-0 truncate">{props.modelLabel}</span>
    </span>
  );
}

/**
 * "Working 1m 31s · Runs on its own". The label is written from an effect and
 * ticks through DOM writes, so a running timer never re-renders the chat view.
 */
function SubagentStatus(props: {
  readonly status: ComponentProps<typeof ProviderSubagentBar>["status"];
  readonly modelDescription: string;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  // Announced once per transition; the ticking label is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs tabular-nums">
      <span ref={statusRef} aria-hidden className="truncate" />
      <span aria-hidden className="shrink-0 @max-[620px]/composer-surface:hidden">
        · Runs on its own
      </span>
      <span role="status" className="sr-only">
        {`${props.modelDescription} subagent: ${announcement}`}
      </span>
    </span>
  );
}
