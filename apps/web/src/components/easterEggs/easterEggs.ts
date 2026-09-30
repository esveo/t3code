import { launchRocket } from "./rocket";
import { useEasterEggStore } from "./easterEggStore";

interface EasterEgg {
  /** The whole message, compared trimmed and case-insensitively. */
  readonly message: string;
  readonly play: () => void;
}

const EASTER_EGGS: ReadonlyArray<EasterEgg> = [{ message: "esveo", play: launchRocket }];

export function findEasterEgg(prompt: string): EasterEgg | null {
  const message = prompt.trim().toLowerCase();
  return EASTER_EGGS.find((egg) => egg.message === message) ?? null;
}

/**
 * Fork: called with every message the composer sends. Plays the easter egg the
 * message spells out, when the user opted in. The message is sent regardless.
 */
export function playEasterEggFor(prompt: string) {
  if (!useEasterEggStore.getState().enabled) return;
  findEasterEgg(prompt)?.play();
}
