/**
 * Fork: thread orchestration. The providers and models a coordinator may pick
 * for start_thread, read from the same provider snapshots the composer's model
 * picker shows, and the check of its pick against them.
 */
import {
  isProviderAvailable,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";

export interface ProviderModels {
  readonly provider: string;
  readonly name: string;
  /** Model ids; empty when the provider decides its models at runtime. */
  readonly models: ReadonlyArray<string>;
  readonly current: boolean;
}

const isUsable = (provider: ServerProvider) =>
  provider.enabled && provider.status !== "disabled" && isProviderAvailable(provider);

/** What list_projects reports: the usable providers with their current models. */
export function listProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: string,
): ReadonlyArray<ProviderModels> {
  return providers.filter(isUsable).map((provider) => ({
    provider: provider.instanceId,
    name: provider.displayName ?? provider.driver,
    models: provider.models.filter((model) => !model.isLegacy).map((model) => model.slug),
    current: provider.instanceId === currentInstanceId,
  }));
}

/** The model the composer would pick for a provider when none is named. */
function defaultModelOf(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom && !model.isLegacy)?.slug ??
    provider.models[0]?.slug
  );
}

/**
 * The model selection for a new thread. Without a pick it is the coordinator's
 * own. A named provider must be one of the usable ones; a named model must be
 * one of that provider's, by id, name or alias. A provider without a model list
 * (models decided at runtime) or a registry that has not loaded yet takes the
 * pick as given rather than refusing it.
 */
export function chooseModelSelection(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
}): { readonly selection: ModelSelection } | { readonly error: string } {
  const { providers, current } = input;
  if (!input.provider && !input.model) return { selection: current };
  const usable = providers.filter(isUsable);
  const instanceId = input.provider ?? current.instanceId;
  const entry = providers.find((candidate) => candidate.instanceId === instanceId);
  if (input.provider && providers.length > 0 && (!entry || !isUsable(entry))) {
    const valid = usable.map((candidate) => candidate.instanceId).join(", ") || "none";
    return {
      error: `${entry ? `Provider ${instanceId} is turned off or unavailable` : `Unknown provider ${instanceId}`}. Providers: ${valid}. list_projects lists them with their models.`,
    };
  }
  const switchesProvider = instanceId !== current.instanceId;
  if (!input.model && !switchesProvider) return { selection: current };
  if (!entry || entry.models.length === 0) {
    return {
      selection: {
        instanceId: ProviderInstanceId.make(instanceId),
        model: input.model ?? current.model,
      },
    };
  }
  if (!input.model) {
    return {
      selection: { instanceId: entry.instanceId, model: defaultModelOf(entry) ?? current.model },
    };
  }
  const slug = resolveSelectableModel(entry.driver, input.model, entry.models);
  if (!slug) {
    const valid = entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => model.slug)
      .join(", ");
    return { error: `${input.model} is not a model of ${entry.instanceId}. Models: ${valid}.` };
  }
  return { selection: { instanceId: entry.instanceId, model: slug } };
}
