import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";

/**
 * Fork: finds the provider instance a thread's model runs on, so a row can show
 * its logo. Resolved per environment like the command palette does.
 */
export function useProviderEntryLookup(): (
  environmentId: EnvironmentId,
  instanceId: string,
) => ProviderInstanceEntry | null {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryProviders = useAtomValue(primaryServerProvidersAtom);
  const entries = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const serverConfig = environment.serverConfig;
      const providers =
        serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? primaryProviders : []);
      const derived = deriveProviderInstanceEntries(providers);
      const resolved = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings)
        : derived;
      for (const entry of resolved)
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
    }
    return map;
  }, [environments, primaryEnvironmentId, primaryProviders]);
  return useCallback(
    (environmentId, instanceId) => entries.get(`${environmentId}:${instanceId}`) ?? null,
    [entries],
  );
}
