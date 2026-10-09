/**
 * Fork: resolves one side of a pull request's diff to a commit in the local
 * clone. A pull request's commits are often not there (a branch never fetched,
 * a contributor's fork), so a missing commit is fetched from the remote that
 * hosts the pull request's repository: by sha, then through the host's pull
 * request ref. Fetching only adds objects (and refreshes the base branch's
 * remote-tracking ref); the working tree and checked-out branch stay as they
 * are. Anything that cannot be resolved is null, so navigation offers nothing
 * there instead of failing.
 */
import type { CodeNavigationRevision } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export type PullRequestRevision = Extract<CodeNavigationRevision, { _tag: "pullRequest" }>;

/** Runs git in `root`; never fails on a non-zero exit, so the caller reads `exitCode`. */
export type RootGit<E> = (
  root: string,
  args: ReadonlyArray<string>,
  options?: { readonly network?: boolean },
) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, E>;

const SHA = /^[0-9a-f]{40,64}$/;
const RESOLVED_TTL = Duration.hours(1);
/** How long an unresolvable side stays unresolved before a hover may fetch again. */
const UNRESOLVED_TTL = Duration.minutes(2);

/** The remote whose URL names `repository` (`owner/name`), over https, ssh or an ssh alias. */
export function remoteForRepository(remotes: string, repository: string): string | null {
  const wanted = repository.toLowerCase().replace(/\.git$/, "");
  for (const line of remotes.split("\n")) {
    const [name, url, kind] = line.split(/\s+/);
    if (!name || !url || kind !== "(fetch)") continue;
    const path = url
      .toLowerCase()
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    if (path.endsWith(`/${wanted}`) || path.endsWith(`:${wanted}`)) return name;
  }
  return null;
}

export const makePullRequestRevisions = <E>(git: RootGit<E>) =>
  Effect.gen(function* () {
    const ok = (root: string, args: ReadonlyArray<string>, network = false) =>
      git(root, args, { network }).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
        Effect.orElseSucceed(() => null),
      );
    const commitOf = (root: string, rev: string) =>
      ok(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).pipe(
        Effect.map((sha) => (sha && SHA.test(sha) ? sha : null)),
      );
    const remoteOf = (root: string, repository: string) =>
      ok(root, ["remote", "-v"]).pipe(
        Effect.map((remotes) => (remotes ? remoteForRepository(remotes, repository) : null)),
      );
    const fetch = (root: string, remote: string, refspec: string) =>
      ok(
        root,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-recurse-submodules",
          remote,
          refspec,
        ],
        true,
      );

    /** Whether `sha` is in the clone, fetching it once per root when it is not. */
    const presentCache = yield* Cache.makeWith(
      (key: string) => {
        const [root, remote, sha, number] = JSON.parse(key) as [
          string,
          string | null,
          string,
          number,
        ];
        return Effect.gen(function* () {
          if (yield* commitOf(root, sha)) return true;
          if (!remote) return false;
          yield* fetch(root, remote, sha);
          if (yield* commitOf(root, sha)) return true;
          // Hosts that refuse to serve a bare sha still serve the pull request's head ref,
          // and every commit of the pull request is reachable from it.
          yield* fetch(root, remote, `refs/pull/${number}/head`);
          if (yield* commitOf(root, sha)) return true;
          yield* fetch(root, remote, `refs/merge-requests/${number}/head`);
          return (yield* commitOf(root, sha)) !== null;
        });
      },
      {
        capacity: 512,
        timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value ? RESOLVED_TTL : UNRESOLVED_TTL),
      },
    );
    const ensure = (root: string, remote: string | null, sha: string, number: number) =>
      Cache.get(presentCache, JSON.stringify([root, remote, sha, number]));

    const headOf = (root: string, remote: string | null, revision: PullRequestRevision) =>
      Effect.gen(function* () {
        const known = revision.commit ?? revision.headSha;
        if (known) return SHA.test(known) ? known : null;
        if (!remote) return null;
        const listed = yield* ok(
          root,
          [
            "ls-remote",
            remote,
            `refs/pull/${revision.number}/head`,
            `refs/merge-requests/${revision.number}/head`,
          ],
          true,
        );
        const sha = listed?.split(/\s+/)[0];
        return sha && SHA.test(sha) ? sha : null;
      });

    const resolveUncached = (root: string, revision: PullRequestRevision) =>
      Effect.gen(function* () {
        const remote = yield* remoteOf(root, revision.repository);
        const head = yield* headOf(root, remote, revision);
        if (!head || !(yield* ensure(root, remote, head, revision.number))) return null;
        if (revision.side === "head") return head;
        // One commit's diff runs from its first parent, as the hosts show it.
        if (revision.commit) return yield* commitOf(root, `${head}^1`);
        const mergeBase = yield* mergeBaseOf(root, remote, head, revision.baseBranch);
        if (mergeBase && mergeBase !== head) return mergeBase;
        // The head is already in the base branch (merged without squashing): the change
        // started at its oldest commit's parent.
        const first = revision.firstCommit;
        if (!first || !SHA.test(first) || !(yield* ensure(root, remote, first, revision.number))) {
          return null;
        }
        return yield* commitOf(root, `${first}^1`);
      });

    /** The merge base with the base branch, refreshing a tracking ref that may be stale. */
    const mergeBaseOf = (root: string, remote: string | null, head: string, baseBranch: string) =>
      Effect.gen(function* () {
        const tracking = remote
          ? `refs/remotes/${remote}/${baseBranch}`
          : `refs/heads/${baseBranch}`;
        const tip = yield* commitOf(root, tracking);
        const mergeBase = tip ? yield* ok(root, ["merge-base", head, tip]) : null;
        // A tip that is missing, or that the head already contains, may only be behind: the
        // branch could have been cut from a later base. One fetch settles it.
        if (remote && (!tip || mergeBase === tip)) {
          yield* fetch(root, remote, `+refs/heads/${baseBranch}:${tracking}`);
          const fresh = yield* commitOf(root, tracking);
          if (fresh && fresh !== tip) return yield* ok(root, ["merge-base", head, fresh]);
        }
        return mergeBase;
      });

    const resolvedCache = yield* Cache.makeWith(
      (key: string) => {
        const [root, revision] = JSON.parse(key) as [string, PullRequestRevision];
        return resolveUncached(root, revision);
      },
      {
        capacity: 512,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value !== null ? RESOLVED_TTL : UNRESOLVED_TTL,
      },
    );

    /** The commit `revision` names in the clone at `root`, or null. */
    return (root: string, revision: PullRequestRevision) =>
      Cache.get(
        resolvedCache,
        JSON.stringify([
          root,
          {
            _tag: revision._tag,
            side: revision.side,
            repository: revision.repository,
            number: revision.number,
            baseBranch: revision.baseBranch,
            headSha: revision.headSha,
            firstCommit: revision.firstCommit,
            commit: revision.commit,
          },
        ]),
      );
  });
