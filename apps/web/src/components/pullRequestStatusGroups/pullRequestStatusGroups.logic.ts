/**
 * Fork: splits a thread's pull-request lines into sections by lifecycle state,
 * like the threads overview groups its rows by what they need from the user.
 */
import type { ThreadPullRequestLink } from "@t3tools/contracts";

import type { PullRequestListLine } from "../pullRequest/pullRequestListLines";

export type PullRequestStatusGroupId = "open" | "draft" | "merged" | "closed";

export interface PullRequestStatusGroup {
  readonly id: PullRequestStatusGroupId;
  readonly label: string;
  readonly lines: ReadonlyArray<PullRequestListLine>;
}

const GROUP_ORDER: ReadonlyArray<{ id: PullRequestStatusGroupId; label: string }> = [
  { id: "open", label: "Open" },
  { id: "draft", label: "Draft" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
];

/** Finished pull requests fold away by default; open work stays visible. */
export const SETTLED_PULL_REQUEST_GROUPS: ReadonlySet<PullRequestStatusGroupId> = new Set([
  "merged",
  "closed",
]);

/** A link the host has not answered for yet counts as open: it was just linked. */
function statusGroupOf(link: ThreadPullRequestLink): PullRequestStatusGroupId {
  const snapshot = link.snapshot;
  if (snapshot === null) return "open";
  if (snapshot.state === "open") return snapshot.isDraft ? "draft" : "open";
  return snapshot.state;
}

/**
 * Keeps the lines' order within each section. A stack whose layers land in different sections
 * is re-indented per section, so a layer whose base already merged does not hang indented under
 * nothing, and the stack badge moves to the first layer each section shows.
 */
export function groupPullRequestLinesByStatus(
  lines: ReadonlyArray<PullRequestListLine>,
): ReadonlyArray<PullRequestStatusGroup> {
  const byGroup = new Map<PullRequestStatusGroupId, PullRequestListLine[]>();
  for (const line of lines) {
    const id = statusGroupOf(line.link);
    const held = byGroup.get(id) ?? [];
    held.push(line);
    byGroup.set(id, held);
  }
  const stackOf = new Map(
    lines.filter((line) => line.stack !== null).map((line) => [line.chainKey, line.stack]),
  );
  return GROUP_ORDER.flatMap(({ id, label }) => {
    const grouped = byGroup.get(id);
    if (!grouped) return [];
    const seen = new Map<string, number>();
    const minDepth = new Map<string, number>();
    for (const line of grouped) {
      minDepth.set(line.chainKey, Math.min(minDepth.get(line.chainKey) ?? line.depth, line.depth));
    }
    return [
      {
        id,
        label,
        lines: grouped.map((line) => {
          const index = seen.get(line.chainKey) ?? 0;
          seen.set(line.chainKey, index + 1);
          return {
            ...line,
            depth: line.depth - (minDepth.get(line.chainKey) ?? 0),
            stack: index === 0 ? (stackOf.get(line.chainKey) ?? null) : null,
          };
        }),
      },
    ];
  });
}
