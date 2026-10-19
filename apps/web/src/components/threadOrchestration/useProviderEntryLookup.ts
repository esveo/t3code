import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useEnvironmentProviders, useEnvironments } from "~/state/environments";

/**
 * Fork: finds the provider instance a thread's model runs on, so a row can show
 * its logo. Resolved per environment like the command palette does.
 */
export function useProviderEntryLookup(): (
  environmentId: EnvironmentId,
  instanceId: string,
) => ProviderInstanceEntry | null {
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const entries = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const serverConfig = environment.serverConfig;
      const providers = providersByEnvironment.get(environment.environmentId) ?? [];
      const derived = deriveProviderInstanceEntries(providers);
      const resolved = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      for (const entry of resolved)
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
    }
    return map;
  }, [environments, providersByEnvironment]);
  return useCallback(
    (environmentId, instanceId) => entries.get(`${environmentId}:${instanceId}`) ?? null,
    [entries],
  );
}
