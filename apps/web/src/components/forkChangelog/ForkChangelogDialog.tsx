// Fork: "What's new in esveo code". Shows the changelog entries that arrived
// since the client's last start, and the whole changelog from the command
// palette. Mounted once in the root route.
import { SparklesIcon } from "lucide-react";
import { useEffect } from "react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import type { ForkChangelogEntry } from "./forkChangelog.logic";
import { FORK_CHANGELOG_ENTRIES, useForkChangelogStore } from "./forkChangelogStore";

export const forkChangelogCommandItem: CommandPaletteActionItem = {
  kind: "action",
  value: "action:fork-whats-new",
  searchTerms: ["what's new", "whats new", "changelog", "features", "release notes", "neu"],
  title: "What's new",
  icon: <SparklesIcon className={ITEM_ICON_CLASS} />,
  run: async () => useForkChangelogStore.getState().showAll(),
};

export function ForkChangelogDialog() {
  const open = useForkChangelogStore((state) => state.open);
  const view = useForkChangelogStore((state) => state.view);
  const newEntries = useForkChangelogStore((state) => state.newEntries);
  const entries = view === "new" ? newEntries : FORK_CHANGELOG_ENTRIES;

  useEffect(() => {
    useForkChangelogStore.getState().showNewSinceLastStart();
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) useForkChangelogStore.getState().close();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>What's new in esveo code</DialogTitle>
          <DialogDescription>
            {view === "new"
              ? "Added by your colleagues since you last started the app."
              : "Everything esveo's fork adds to T3 Code, newest first."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed">
            {entries.map((entry) => (
              <li key={entry.commits[0] ?? entry.text}>
                <ForkChangelogText entry={entry} />
              </li>
            ))}
          </ul>
        </DialogPanel>
        <DialogFooter>
          {view === "new" ? (
            <Button onClick={() => useForkChangelogStore.getState().showAll()} variant="outline">
              Show all
            </Button>
          ) : null}
          <Button onClick={() => useForkChangelogStore.getState().close()}>Got it</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The entry's sentence, with its `code` spans set in code. */
function ForkChangelogText({ entry }: { readonly entry: ForkChangelogEntry }) {
  let offset = 0;
  return entry.text.split("`").map((part, index) => {
    const start = offset;
    offset += part.length + 1;
    return index % 2 === 1 ? (
      <code className="rounded bg-muted px-1 font-mono text-xs" key={start}>
        {part}
      </code>
    ) : (
      part
    );
  });
}
