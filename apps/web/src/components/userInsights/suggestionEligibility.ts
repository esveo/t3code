/**
 * Fork: user insights. Whether this chat view should ask its server for
 * next-message suggestions now. Pure; the hook feeds it what it sees.
 */
import type { UserInsightsSuggestSkip } from "@t3tools/contracts";

/** Wait this long after a turn finished before asking, so a quick reply wins. */
export const SUGGESTION_DELAY_MS = 1_500;
/** After an environment-wide "no", ask that server again only after this long. */
export const ENVIRONMENT_RETRY_MS = 10 * 60 * 1000;

export interface SuggestionEligibilityInput {
  /** User insights and its suggestions are both on for this environment. */
  readonly enabled: boolean;
  /** The server recently said no for every thread (off, not ready, paused). */
  readonly environmentWaiting: boolean;
  readonly isActivePane: boolean;
  readonly documentVisible: boolean;
  readonly documentFocused: boolean;
  readonly thread: {
    readonly latestRun: { readonly runId: string; readonly status: string } | null;
    readonly runtimeActive: boolean;
    readonly isSubagent: boolean;
    readonly hasPendingRuntimeRequest: boolean;
  } | null;
  /** Approvals or questions waiting in the composer. */
  readonly hasPendingRequests: boolean;
  readonly promptEmpty: boolean;
  /** The run this view last asked about, so one turn is asked about once. */
  readonly lastAskedRunId: string | null;
}

export type SuggestionEligibility =
  | { readonly eligible: true; readonly runId: string }
  | { readonly eligible: false; readonly reason: string };

export function suggestionEligibility(input: SuggestionEligibilityInput): SuggestionEligibility {
  const no = (reason: string): SuggestionEligibility => ({ eligible: false, reason });
  if (!input.enabled) return no("off");
  if (input.environmentWaiting) return no("environment-waiting");
  if (!input.isActivePane) return no("inactive-pane");
  const thread = input.thread;
  if (thread === null || thread.latestRun === null) return no("no-turn");
  if (thread.isSubagent) return no("subagent");
  if (thread.runtimeActive || thread.latestRun.status !== "completed") return no("running");
  if (thread.hasPendingRuntimeRequest || input.hasPendingRequests) return no("pending-request");
  if (thread.latestRun.runId === input.lastAskedRunId) return no("already-asked");
  if (!input.promptEmpty) return no("prompt-not-empty");
  if (!input.documentVisible || !input.documentFocused) return no("not-focused");
  return { eligible: true, runId: thread.latestRun.runId };
}

const ENVIRONMENT_WIDE_SKIPS: ReadonlySet<UserInsightsSuggestSkip> = new Set([
  "off",
  "not-ready",
  "paused",
  "daily-limit",
]);

/** Skips that hold for every thread of the server, not just this turn. */
export const isEnvironmentWideSkip = (skip: UserInsightsSuggestSkip | null) =>
  skip !== null && ENVIRONMENT_WIDE_SKIPS.has(skip);
