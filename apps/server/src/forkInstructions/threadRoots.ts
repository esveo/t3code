/**
 * Fork: the provider and folders the Instructions tab reads for a thread, from
 * the thread's provider instance as the server runs it.
 */
import {
  type ForkInstructionsProvider,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import type { InstructionRoots } from "./instructionFiles.ts";

const DRIVER_BY_PROVIDER = { claude: "claudeAgent", codex: "codex" } as const;

/** The instance's driver, `homePath` and environment overrides, read off its untyped config. */
const instanceHome = (
  providerInstances: ServerSettings["providerInstances"],
  instanceId: string,
) => {
  const instance = Object.hasOwn(providerInstances, instanceId)
    ? providerInstances[ProviderInstanceId.make(instanceId)]
    : undefined;
  const config: unknown = instance?.config;
  const homePath =
    typeof config === "object" && config !== null && "homePath" in config
      ? typeof config.homePath === "string"
        ? config.homePath
        : ""
      : "";
  const environment = Object.fromEntries(
    (instance?.environment ?? []).map((variable) => [variable.name, variable.value]),
  );
  // An instance missing from the settings is a default one, whose id is its driver.
  return { driver: instance?.driver ?? instanceId, homePath, environment };
};

export const threadRoots = Effect.fn("forkInstructions.threadRoots")(function* (input: {
  readonly provider: ForkInstructionsProvider | undefined;
  readonly threadInstanceId: string;
  /** The thread's worktree, else its project's root. */
  readonly checkout: string;
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly environment: NodeJS.ProcessEnv;
  readonly home: string;
}) {
  const path = yield* Path.Path;
  const threadInstance = instanceHome(input.providerInstances, input.threadInstanceId);
  const provider: ForkInstructionsProvider =
    input.provider ?? (threadInstance.driver === "codex" ? "codex" : "claude");
  // The thread's own instance when it runs this provider, else the provider's default one.
  const instance =
    threadInstance.driver === DRIVER_BY_PROVIDER[provider]
      ? threadInstance
      : instanceHome(input.providerInstances, DRIVER_BY_PROVIDER[provider]);
  const environment = { ...input.environment, ...instance.environment };
  const claudeConfigDir = yield* resolveClaudeHomePath(
    { homePath: instance.homePath },
    environment,
  ).pipe(Effect.provideService(HostProcess.HomeDirectory, input.home));
  const codexHomeSetting = instance.homePath.trim() || environment.CODEX_HOME?.trim() || "";
  const codexHome = path.resolve(
    codexHomeSetting.length > 0
      ? expandHomePath(codexHomeSetting, input.home)
      : path.join(input.home, ".codex"),
  );
  const roots: InstructionRoots = {
    home: input.home,
    checkout: input.checkout,
    claudeConfigDir,
    codexHome,
  };
  return { provider, roots };
});
