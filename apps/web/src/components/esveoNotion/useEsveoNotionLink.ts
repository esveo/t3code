import { type EnvironmentId, parseNotionPageUrl, type ScopedThreadRef } from "@t3tools/contracts";
import { type MouseEvent, useEffect } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { esveoNotionEnvironment } from "./esveoNotionState";
import { openNotionPage, useEsveoNotionStore } from "./esveoNotionStore";

/** Environments whose status was asked for once; the settings row refreshes it after changes. */
const requested = new Set<string>();

/** Loads the environment's Notion status once, so links can decide on click. */
export function useEsveoNotionStatus(environmentId: EnvironmentId | null | undefined) {
  const readStatus = useAtomCommand(esveoNotionEnvironment.status, { reportFailure: false });
  const status = useEsveoNotionStore((state) =>
    environmentId ? state.statusByEnvironment[environmentId] : undefined,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the server's Notion connection once per environment
  useEffect(() => {
    if (!environmentId || requested.has(environmentId)) return;
    requested.add(environmentId);
    void readStatus({ environmentId, input: {} }).then((result) => {
      if (result._tag === "Success") {
        useEsveoNotionStore.getState().setStatus(environmentId, result.value);
      } else {
        requested.delete(environmentId);
      }
    });
  }, [environmentId, readStatus]);
  return status;
}

type LinkEvent = Pick<
  MouseEvent<HTMLElement>,
  "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
> &
  Partial<Pick<MouseEvent<HTMLElement>, "button">>;

/**
 * Fork: Notion links open in a right-panel tab while the environment has a
 * Notion integration; ⌘/Ctrl- and middle-clicks keep opening the browser.
 */
export function useOpenEsveoNotionLink(threadRef?: ScopedThreadRef, panelRef?: ScopedThreadRef) {
  useEsveoNotionStatus(threadRef?.environmentId);
  return (event: LinkEvent, url: string, targetThreadRef?: ScopedThreadRef): boolean => {
    const ref = targetThreadRef ?? panelRef ?? threadRef;
    if (ref === undefined || event.metaKey || event.ctrlKey || event.button === 1) return false;
    const pageId = parseNotionPageUrl(url);
    if (pageId === null) return false;
    const environmentId = (targetThreadRef ?? threadRef ?? ref).environmentId;
    if (useEsveoNotionStore.getState().statusByEnvironment[environmentId]?.connected !== true) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    openNotionPage(ref, pageId);
    return true;
  };
}
