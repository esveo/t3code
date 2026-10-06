// Fork: the "this pull request changed" prompt over the code tab.
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";

export function PullRequestDiffUpdateNotice({ onRefresh }: { readonly onRefresh: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <div className="pointer-events-auto rounded-md shadow-md">
        <Button onClick={onRefresh} size="sm">
          <RefreshIcon aria-hidden size="sm" />
          New changes · Refresh
        </Button>
      </div>
    </div>
  );
}
