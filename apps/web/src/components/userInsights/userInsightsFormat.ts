import type {
  UserInsightsStatus,
  UserInsightsTraitId,
  UserInsightsUsageSummary,
  UserInsightsUsageTotals,
} from "@t3tools/contracts";

/** Fork: user insights. Texts for the settings section; confidence never shows as a percentage. */

export type ConfidenceLevel = "low" | "medium" | "high";

/** Same thresholds as the server's `confidenceLevel`. */
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence < 0.5) return "low";
  if (confidence < 0.75) return "medium";
  return "high";
}

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const TRAIT_LABELS: Record<UserInsightsTraitId, string> = {
  "style.language": "Language",
  "style.length": "Message length",
  "style.tone": "Tone",
  "style.format": "Formatting",
  "work.stack": "Stack",
  "work.taskMix": "Kinds of tasks",
  "work.granularity": "Task size",
  "work.verification": "Verification",
  "flow.followups": "Follow-ups",
  "prefs.agent": "Agent preferences",
  "notes.1": "Note",
  "notes.2": "Note",
  "notes.3": "Note",
  "notes.4": "Note",
  "notes.5": "Note",
};

export function traitLabel(id: UserInsightsTraitId): string {
  return TRAIT_LABELS[id];
}

export function statusText(status: UserInsightsStatus): string {
  switch (status.state) {
    case "off":
      return "Off";
    case "learning":
      return `Learning: ${status.samples} of ${status.requiredSamples} messages before suggestions start${
        status.pending ? `, ${status.pending} collected for the next update` : ""
      }`;
    case "ready":
      return "Ready: suggestions can appear after a finished turn";
    case "paused":
      switch (status.reason) {
        case "budget":
          return "Paused until tomorrow: today's cap is reached";
        case "backoff":
          return "Paused for a while after a failed call";
        case "claude-unavailable":
          return "Paused: Claude is turned off in Providers";
        case "low-acceptance":
          return "Suggestions paused: few were used lately. Turn suggestions off and on to try again.";
      }
  }
}

export function formatCostUsd(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  if (costUsd < 0.01) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatUsageTotals(totals: UserInsightsUsageTotals): string {
  if (totals.calls === 0) return "No calls";
  const calls = totals.calls === 1 ? "1 call" : `${totals.calls} calls`;
  return `${calls}, ${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out tokens, ${formatCostUsd(totals.costUsd)}`;
}

export function capsText(usage: UserInsightsUsageSummary): string {
  return `Daily caps: ${formatCostUsd(usage.dailyCapUsd)} equivalent API cost, ${usage.maxDistillsPerDay} learning runs, ${usage.maxSuggestsPerDay} suggestion sets.`;
}
