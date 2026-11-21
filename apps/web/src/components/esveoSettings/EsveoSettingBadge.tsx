import { T } from "gt-react";
import type { ReactNode } from "react";

import { SETTINGS_SEARCH_ITEMS, type SettingsSearchItemId } from "../settings/settingsSearch";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { requestEsveoSettingsSearch } from "./esveoSettingsSearch";

/**
 * Fork: marks a setting as one esveo's fork adds. A click fills the settings
 * search with "esveo", which lists every such setting.
 */
export function EsveoSettingBadge() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant="outline" size="sm" render={<button type="button" />} />}
        onClick={requestEsveoSettingsSearch}
      >
        esveo
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Added by esveo's fork. Click to list all of its settings.</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Fork: a settings search item's anchor id and title; fork titles are plain English. */
export function forkSearchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const item = SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.id === id)!;
  return { id: item.id, title: item.title };
}

/**
 * Fork: `forkSearchableSetting` for a fork row, its title carrying the esveo badge.
 * Its search item sets `fork: true`, so searching "esveo" finds it.
 */
export function esveoSearchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: ReactNode;
} {
  const { id: anchorId, title } = forkSearchableSetting(id);
  return {
    id: anchorId,
    title: (
      <span className="inline-flex items-center gap-1.5">
        {title}
        <EsveoSettingBadge />
      </span>
    ),
  };
}
