import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

/** Fork: whether the Android thread row shows the project. On by default. */
export const esveoThreadRowShowsProjectAtom = Atom.make((get) => {
  const preferences = get(mobilePreferencesAtom);
  return !(
    AsyncResult.isSuccess(preferences) && preferences.value.esveoThreadRowShowsProject === false
  );
}).pipe(Atom.withLabel("mobile:esveo-thread-row-shows-project"));
