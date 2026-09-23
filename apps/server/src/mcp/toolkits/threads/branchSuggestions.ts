/**
 * Fork: thread orchestration. When start_thread's baseBranch does not resolve,
 * the error names the branches the coordinator most likely meant, so it can
 * call again with the right one. It never picks one on the coordinator's behalf.
 */

const MAX_SUGGESTIONS = 5;

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** Lower is closer; null when the name is not worth suggesting. */
function score(wanted: string, ref: { readonly name: string; readonly branchName: string }) {
  const name = ref.name.toLowerCase();
  const branch = ref.branchName.toLowerCase();
  if (branch === wanted) return 0;
  if (branch.endsWith(`/${wanted}`) || name.endsWith(`/${wanted}`)) return 1;
  if (name.includes(wanted)) return 2;
  const lastSegment = branch.slice(branch.lastIndexOf("/") + 1);
  const distance = Math.min(editDistance(wanted, branch), editDistance(wanted, lastSegment));
  return distance <= Math.max(2, Math.floor(wanted.length / 4)) ? 3 + distance : null;
}

/**
 * Up to five branch names close to `wanted`: an exact name on a remote, names
 * ending in or containing it, then near misses. Locals come before remotes.
 */
export function suggestBranches(
  wanted: string,
  refs: ReadonlyArray<{
    readonly name: string;
    readonly isRemote?: boolean | undefined;
    readonly remoteName?: string | undefined;
  }>,
): string[] {
  const query = wanted.trim().toLowerCase();
  if (query.length === 0) return [];
  return refs
    .flatMap((ref) => {
      const branchName =
        ref.isRemote && ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)
          ? ref.name.slice(ref.remoteName.length + 1)
          : ref.name;
      if (ref.isRemote && branchName === "HEAD") return [];
      const value = score(query, { name: ref.name, branchName });
      return value === null ? [] : [{ name: ref.name, value, remote: ref.isRemote === true }];
    })
    .toSorted(
      (left, right) =>
        left.value - right.value ||
        Number(left.remote) - Number(right.remote) ||
        left.name.localeCompare(right.name),
    )
    .map((candidate) => candidate.name)
    .filter((name, index, names) => names.indexOf(name) === index)
    .slice(0, MAX_SUGGESTIONS);
}
