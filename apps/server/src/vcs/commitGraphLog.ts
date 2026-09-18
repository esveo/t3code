import type { VcsCommitGraphEntry, VcsCommitGraphRef } from "@t3tools/contracts";

/**
 * Reading `git log` for the commit graph view.
 *
 * The format is byte-separated rather than line-based because a commit subject
 * may contain anything, newlines included. Records end with US-ASCII RS and
 * fields are split by US-ASCII US, neither of which Git ever emits itself.
 */
const FIELD_SEPARATOR = "";
const RECORD_SEPARATOR = "";

// %D with --decorate=full spells refs out as refs/heads/..., refs/remotes/...,
// refs/tags/..., which is what makes the ref kinds unambiguous.
const LOG_FORMAT = ["%H", "%P", "%D", "%an", "%aI", "%s"].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;

/**
 * T3 writes a hidden checkpoint commit per turn under `refs/t3/`. Those are
 * parentless and carry the current date, so they would sit at the top of every
 * graph as loose dots. Excluding the refs keeps them out of `--all` entirely;
 * the ordering matters, `--exclude` only applies to the globs that follow it.
 */
export function commitGraphLogArgs(input: { readonly limit: number }): ReadonlyArray<string> {
  return [
    "log",
    `--format=${LOG_FORMAT}`,
    "--decorate=full",
    "--exclude=refs/t3/*",
    "--all",
    // One extra commit answers "is there more behind the window" without a second call.
    `--max-count=${input.limit + 1}`,
  ];
}

/** Splits one `git log` record; returns null for anything that is not a full commit. */
function parseRecord(record: string): VcsCommitGraphEntry | null {
  const fields = record.split(FIELD_SEPARATOR);
  if (fields.length < 6) return null;
  const [sha, parents, decorations, author, authoredAt, ...subjectParts] = fields;
  if (!sha || !authoredAt) return null;
  return {
    sha,
    parents: (parents ?? "").split(" ").filter((parent) => parent.length > 0),
    refs: parseDecorations(decorations ?? ""),
    author: author ?? "",
    authoredAt,
    // A subject containing the field separator would otherwise lose its tail.
    subject: subjectParts.join(FIELD_SEPARATOR),
  };
}

const HEAD_ARROW = "HEAD -> ";

/** Classifies one decoration, e.g. `refs/remotes/origin/main` -> remote `origin/main`. */
function parseDecoration(decoration: string): VcsCommitGraphRef | null {
  const trimmed = decoration.trim();
  if (trimmed.length === 0) return null;
  // `HEAD -> refs/heads/main` means HEAD is on that branch; the branch itself
  // is not listed a second time, so the head ref carries the branch name.
  if (trimmed.startsWith(HEAD_ARROW)) {
    const target = trimmed.slice(HEAD_ARROW.length);
    return { kind: "head", name: target.replace(/^refs\/heads\//, "") };
  }
  if (trimmed === "HEAD") return { kind: "head", name: "HEAD" };
  if (trimmed.startsWith("refs/t3/")) return null;
  if (trimmed.startsWith("refs/heads/"))
    return { kind: "branch", name: trimmed.slice("refs/heads/".length) };
  if (trimmed.startsWith("refs/remotes/"))
    return { kind: "remote", name: trimmed.slice("refs/remotes/".length) };
  if (trimmed.startsWith("refs/tags/"))
    return { kind: "tag", name: trimmed.slice("refs/tags/".length) };
  return { kind: "other", name: trimmed };
}

function parseDecorations(decorations: string): ReadonlyArray<VcsCommitGraphRef> {
  const refs: VcsCommitGraphRef[] = [];
  for (const decoration of decorations.split(", ")) {
    const ref = parseDecoration(decoration);
    if (ref !== null && ref.name.length > 0) refs.push(ref);
  }
  return refs;
}

export function parseCommitGraphLog(stdout: string): ReadonlyArray<VcsCommitGraphEntry> {
  const commits: VcsCommitGraphEntry[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    // Records are newline-delimited by `git log` on top of our separator.
    const parsed = parseRecord(record.replace(/^\n/, ""));
    if (parsed !== null) commits.push(parsed);
  }
  return commits;
}
