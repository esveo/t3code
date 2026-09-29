import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { SettingsRow } from "../settings/settingsLayout";
import { esveoSearchableSetting } from "~/components/esveoSettings/EsveoSettingBadge";
import { Switch } from "../ui/switch";

/**
 * Fork: whether the sidebar nests a coordinator's threads under it. Off, the
 * sidebar lists threads as upstream does: delegated children stay hidden and
 * are reached through the Threads panel. Stored in this browser.
 */
const useSidebarChildThreadsStore = create<{
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "t3code:fork-sidebar-child-threads:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

export function useSidebarChildThreadsEnabled(): boolean {
  return useSidebarChildThreadsStore((state) => state.enabled);
}

export function SidebarChildThreadsSettingRow() {
  const enabled = useSidebarChildThreadsStore((state) => state.enabled);
  const setEnabled = useSidebarChildThreadsStore((state) => state.setEnabled);
  return (
    <SettingsRow
      {...esveoSearchableSetting("sidebar-child-threads")}
      description="Lists the threads a coordinator started under it in the sidebar, in a group you can expand. Off, they are reached through the coordinator's Threads panel."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Child threads in the sidebar"
        />
      }
    />
  );
}
