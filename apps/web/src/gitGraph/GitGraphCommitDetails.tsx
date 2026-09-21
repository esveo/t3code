import type { VcsCommitGraphEntry } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

/**
 * Details of the commit selected in the graph. Beside the list where there is
 * room for both, under it otherwise: a fixed side column would leave a
 * panel-width graph with nothing to draw in.
 */
export function GitGraphCommitDetails({
  commit,
  onClose,
}: {
  readonly commit: VcsCommitGraphEntry;
  readonly onClose: () => void;
}) {
  const authored = new Date(commit.authoredAt);
  return (
    <aside className="flex max-h-[45%] w-full shrink-0 flex-col gap-3 overflow-auto border-t p-4 @2xl/gitgraph:max-h-none @2xl/gitgraph:w-80 @2xl/gitgraph:border-t-0 @2xl/gitgraph:border-l">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm font-semibold break-words">{commit.subject}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close commit details">
          <XIcon className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {commit.author}
        {Number.isNaN(authored.getTime()) ? null : ` · ${authored.toLocaleString()}`}
      </p>
      <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono break-all">{commit.sha}</dd>
        {commit.parents.length > 0 ? (
          <>
            <dt className="text-muted-foreground">
              {commit.parents.length > 1 ? "Parents" : "Parent"}
            </dt>
            <dd className="font-mono">
              {commit.parents.map((parent) => (
                <div key={parent}>{parent.slice(0, 12)}</div>
              ))}
            </dd>
          </>
        ) : null}
        {commit.refs.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Refs</dt>
            <dd className="break-words">{commit.refs.map((ref) => ref.name).join(", ")}</dd>
          </>
        ) : null}
      </dl>
    </aside>
  );
}
