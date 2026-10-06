// Fork: a pull request that changes while it is open offers a refresh, like GitHub does, instead
// of redrawing the diff under the reader.
import { useCallback, useEffect, useState } from "react";

import {
  isPullRequestDiffOutdated,
  type ShownPullRequestDiff,
} from "./pullRequestDiffUpdate.logic";

/**
 * Tracks which revision the code tab shows. `accept` takes the current one (the caller then
 * rereads the diff); `acceptNext` takes whatever the detail read in flight answers with, for a
 * refresh the reader asked for.
 */
export function usePullRequestDiffUpdate(input: {
  readonly key: string;
  readonly revision: string | null;
  readonly settled: boolean;
}) {
  const { key, revision, settled } = input;
  const [shown, setShown] = useState<ShownPullRequestDiff | null>(null);
  useEffect(() => {
    if (revision === null || !settled) return;
    if (shown === null || shown.key !== key) setShown({ key, revision });
  }, [key, revision, settled, shown]);
  const accept = useCallback(() => {
    if (revision !== null) setShown({ key, revision });
  }, [key, revision]);
  const acceptNext = useCallback(() => setShown(null), []);
  return { outdated: isPullRequestDiffOutdated(shown, key, revision), accept, acceptNext };
}
