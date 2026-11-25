import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import type { MouseEvent, ReactNode } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";
import { environmentThreadShells } from "~/state/threads";
import {
  coordinatorLinksKey,
  overridesByEnvironmentAtom,
} from "../threadOrchestration/coordinatorLinks";
import { useOpenThread } from "../threadOrchestration/useOpenThread";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { waitingForYouIndex, waitingForYouKey, waitingThreadIdsOf } from "./waitingForYou.logic";

const indexAtom = Atom.make((get) => {
  const threads = get(environmentThreadShells.threadShellsAtom);
  const key = coordinatorLinksKey(threads, get(environmentPresentations.serverConfigsAtom));
  return waitingForYouIndex(threads, get(overridesByEnvironmentAtom(key)));
}).pipe(Atom.withLabel("fork-waiting-for-you"));

const rowAtom = Atom.family((key: string) =>
  Atom.make((get) => get(indexAtom).get(key) ?? "").pipe(Atom.setIdleTTL(0)),
);
const NONE_ATOM = Atom.make("");

/**
 * Fork: the threads below this one whose request waits on the user, oldest
 * first, while "Parent threads answer child questions" is off; empty otherwise,
 * so the default subscribes to nothing.
 */
export function useWaitingForYou(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): ReadonlyArray<ThreadId> {
  const userAnswers = useEnvironmentSettings(
    thread.environmentId,
    (settings) => !settings.parentsAnswerChildQuestions,
  );
  return waitingThreadIdsOf(
    useAtomValue(
      userAnswers ? rowAtom(waitingForYouKey(thread.environmentId, thread.id)) : NONE_ATOM,
    ),
  );
}

/** The "Waiting for you" status of a sidebar row; opens the thread that has waited longest. */
export function WaitingForYouStatusButton(props: {
  readonly environmentId: EnvironmentId;
  readonly waitingThreadIds: ReadonlyArray<ThreadId>;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const openThread = useOpenThread();
  const oldest = props.waitingThreadIds[0];
  const open = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (oldest !== undefined) openThread(scopeThreadRef(props.environmentId, oldest));
  };
  const count = props.waitingThreadIds.length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={open}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              props.className,
            )}
          >
            {props.children}
          </button>
        }
      />
      <TooltipPopup side="top">
        {count === 1
          ? gt("A thread below this one waits on you. Open it")
          : gt("{count} threads below this one wait on you. Open the oldest", { count })}
      </TooltipPopup>
    </Tooltip>
  );
}
