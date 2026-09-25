import type { EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/unstable/reactivity";

import { formatEnvironmentQueryError } from "~/state/query";
import { toastManager } from "../ui/toast";
import { describeVoiceInputDownload } from "./voiceInput.logic";
import { voiceInputEnvironment } from "./voiceInputState";

let activeDownload: (() => void) | null = null;

/**
 * Downloads the speech model and reports it in a toast that outlives the
 * settings page. No toast appears when the model is already on disk.
 */
export function startVoiceInputModelDownload(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): void {
  if (activeDownload) return;
  let toastId: string | null = null;
  const finish = () => {
    // Deferred: the first callback can fire before `subscribe` returns.
    queueMicrotask(() => {
      unsubscribe();
      activeDownload = null;
    });
  };
  const unsubscribe = registry.subscribe(
    voiceInputEnvironment.prepare({ environmentId, input: {} }),
    (result) => {
      if (result._tag === "Failure") {
        const failure = {
          type: "error" as const,
          title: "Couldn't download the speech model",
          description: formatEnvironmentQueryError(result.cause),
          timeout: 0,
        };
        if (toastId) toastManager.update(toastId, failure);
        else toastManager.add(failure);
        finish();
        return;
      }
      if (result._tag !== "Success") return;
      const progress = result.value;
      if (progress.phase === "ready") {
        if (toastId) {
          toastManager.update(toastId, {
            type: "success",
            title: "Speech model ready",
            description: "Dictate with the microphone button in the composer.",
            timeout: 5_000,
          });
        }
        finish();
        return;
      }
      const loading = {
        type: "loading" as const,
        title: "Downloading speech model",
        description: describeVoiceInputDownload(progress),
        timeout: 0,
      };
      if (toastId) toastManager.update(toastId, loading);
      else toastId = toastManager.add(loading);
    },
    { immediate: true },
  );
  activeDownload = unsubscribe;
}
