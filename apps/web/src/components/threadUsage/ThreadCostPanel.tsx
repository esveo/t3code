import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { RotateCwIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  formatThreadCost,
  threadCostNote,
  threadTokenRows,
  threadTotalTokens,
  threadUsageState,
} from "./threadUsage.logic";
import { useThreadUsage } from "./threadUsageState";

function Row(props: {
  readonly label: string;
  readonly value: string;
  readonly muted?: boolean;
  readonly indent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className={cn("text-secondary-label", props.indent && "ps-2 opacity-80")}>
        {props.label}
      </span>
      <span
        className={cn(
          "tabular-nums",
          props.muted ? "text-secondary-label" : "font-medium text-secondary-label",
        )}
      >
        {props.value}
      </span>
    </div>
  );
}

function Message({ children }: { readonly children: React.ReactNode }) {
  return <div className="text-pretty text-secondary-label text-[11px] leading-4">{children}</div>;
}

/**
 * What this thread has cost, from its provider's own transcript.
 *
 * Only mounted while the Cost tab is showing: the figures come from a
 * transcript scan, which is too much work to do behind a hover.
 */
export function ThreadCostPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}) {
  const { data, error, isPending, refresh } = useThreadUsage({
    environmentId: props.environmentId,
    threadId: props.threadId,
    enabled: true,
  });

  if (error !== null) {
    return <Message>{error}</Message>;
  }
  if (data === null) {
    return (
      <div className="flex items-center gap-2 text-secondary-label text-[11px]">
        <Spinner className="size-3" />
        Reading this thread's transcript...
      </div>
    );
  }

  const state = threadUsageState(data);
  if (state === "unattributed") {
    return (
      <Message>
        This thread has no provider transcript to read yet. Claude, Codex and Grok threads report
        their own usage once they have run.
      </Message>
    );
  }
  if (state === "empty") {
    return <Message>No usage recorded for this thread's session.</Message>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-secondary-label text-[11px]">Thread cost</span>
        <span className="font-medium text-sm tabular-nums">{formatThreadCost(data.costUsd)}</span>
      </div>
      <div className="flex flex-col gap-1">
        {threadTokenRows(data).map((row) => (
          <Row
            key={row.key}
            label={row.label}
            value={row.value}
            indent={row.key === "reasoning"}
            muted={row.key === "reasoning"}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1 border-border/60 border-t pt-1.5">
        <Row label="Tokens" value={formatTokens(threadTotalTokens(data))} />
        {data.cacheSavingsUsd > 0 ? (
          <Row label="Saved by caching" value={formatThreadCost(data.cacheSavingsUsd)} />
        ) : null}
        {data.models.length > 1
          ? data.models.map((model) => (
              <Row
                key={model.model}
                label={model.model}
                value={formatThreadCost(model.costUsd)}
                muted
              />
            ))
          : null}
      </div>
      <Message>{threadCostNote(data, data.pricing)}</Message>
      <Button
        size="xs"
        variant="outline"
        className="w-full justify-center"
        disabled={isPending}
        onClick={refresh}
      >
        <RotateCwIcon aria-hidden="true" className={cn(isPending && "animate-spin")} />
        {isPending ? "Reading..." : "Refresh"}
      </Button>
    </div>
  );
}
