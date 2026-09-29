/**
 * Fork: the provider subagent bar plus a way to talk to the subagent. Only the
 * parent agent can reach it, so a message typed here goes to the parent thread
 * as a user message asking it to pass it on. Stop ends the running subagent
 * where its provider supports that.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isOrchestrationV2WorkActive, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { SendIcon, SquareIcon } from "lucide-react";
import { type ComponentProps, type FormEvent, useCallback, useMemo, useState } from "react";

import { ProviderSubagentBar } from "~/components/chat/ProviderSubagentBar";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { newMessageId } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildSubagentRelayMessage } from "./subagentRelay.logic";
import { subagentRelayEnvironment } from "./subagentRelayState";

export function SubagentRelayBar(
  props: ComponentProps<typeof ProviderSubagentBar> & {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  },
) {
  const { environmentId, threadId, ...barProps } = props;
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
  const live = props.status !== null && isOrchestrationV2WorkActive(props.status.status);

  const send = useCallback(async () => {
    if (target === null || parent === null || sending || text.trim().length === 0) return;
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
  }, [environmentId, parent, sending, startTurn, target, text]);

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      void send();
    },
    [send],
  );

  const onStop = useCallback(async () => {
    setStopping(true);
    await stop({ environmentId, input: { threadId } });
    setStopping(false);
  }, [environmentId, stop, threadId]);

  return (
    <>
      <ProviderSubagentBar {...barProps} />
      {target === null ? null : (
        <form className="flex items-end gap-2 px-3 pb-3" onSubmit={onSubmit}>
          <div className="min-w-0 flex-1">
            <Textarea
              size="sm"
              value={text}
              placeholder="Message the subagent through its parent"
              aria-label="Message the subagent through its parent"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={parent === null || sending || text.trim().length === 0}
          >
            <SendIcon />
            Send
          </Button>
          {live && target.supportsStop ? (
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              disabled={stopping}
              onClick={() => void onStop()}
            >
              <SquareIcon />
              Stop
            </Button>
          ) : null}
        </form>
      )}
    </>
  );
}
