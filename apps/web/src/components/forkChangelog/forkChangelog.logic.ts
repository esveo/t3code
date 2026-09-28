// Fork: reads docs/fork/changelog.md, bundled into the web app, and tells
// which of its entries a client has not seen yet.

export interface ForkChangelogEntry {
  /** The entry's sentence, without its commit links. */
  readonly text: string;
  /** Short hashes of the commits the entry links, in order. */
  readonly commits: ReadonlyArray<string>;
}

const COMMIT_LINK = /\[([0-9a-f]{7,40})\]\(https:\/\/github\.com\/[^)]+\/commit\/[0-9a-f]+\)/g;

/** The changelog's bullets, newest first as the file lists them. */
export function parseForkChangelog(markdown: string): ForkChangelogEntry[] {
  const entries: ForkChangelogEntry[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim();
    const commits = [...body.matchAll(COMMIT_LINK)].map((match) => match[1]!.slice(0, 7));
    const firstLink = body.search(COMMIT_LINK);
    let text = body;
    if (firstLink !== -1) {
      // The links sit in one trailing parenthesis; the sentence may hold its own.
      const open = body.lastIndexOf("(", firstLink);
      text = body.slice(0, open === -1 ? firstLink : open).trim();
    }
    entries.push({ text: text.replace(/[\s.]+$/, ""), commits });
  }
  return entries;
}

/**
 * The entries with a commit the client has not seen. An entry that gained a
 * fix counts as new again. Without a record (a client's first start) nothing
 * is new: the client has not missed anything it could have seen.
 */
export function findNewForkChangelogEntries(
  entries: ReadonlyArray<ForkChangelogEntry>,
  seenCommits: ReadonlySet<string> | null,
): ForkChangelogEntry[] {
  if (seenCommits === null) return [];
  return entries.filter((entry) => entry.commits.some((commit) => !seenCommits.has(commit)));
}

/** Every commit the changelog links, to record as seen. */
export function collectForkChangelogCommits(entries: ReadonlyArray<ForkChangelogEntry>): string[] {
  return [...new Set(entries.flatMap((entry) => entry.commits))];
}
