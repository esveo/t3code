import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, parseNotionPageUrl, type ThreadId } from "@t3tools/contracts";

import { toastManager } from "~/components/ui/toast";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { EsveoNotionTabIcon } from "./EsveoNotionPanel";
import { openNotionPage, useEsveoNotionStore } from "./esveoNotionStore";

/** Fork: "Notion-Seite öffnen" opens the pasted link, or the one on the clipboard, in a tab. */
export function esveoNotionCommandItems(
  activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null,
  query: string,
): CommandPaletteActionItem[] {
  if (!activeThread) return [];
  const status = useEsveoNotionStore.getState().statusByEnvironment[activeThread.environmentId];
  if (status?.connected !== true) return [];
  const threadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
  const typed = query.trim();
  const typedPageId = parseNotionPageUrl(typed);
  return [
    {
      kind: "action",
      value: "action:esveo-notion-open",
      searchTerms: ["notion", "notion page", "notion-seite", ...(typedPageId ? [typed] : [])],
      title: "Notion-Seite öffnen",
      icon: <EsveoNotionTabIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const pageId =
          typedPageId ??
          parseNotionPageUrl((await navigator.clipboard.readText().catch(() => "")).trim());
        if (pageId === null) {
          toastManager.add({
            type: "info",
            title: "Kein Notion-Link",
            description: "Füge einen Notion-Link in die Suche ein oder kopiere ihn vorher.",
          });
          return;
        }
        openNotionPage(threadRef, pageId);
      },
    },
  ];
}
