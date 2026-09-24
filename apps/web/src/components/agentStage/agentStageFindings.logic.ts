import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";

/**
 * Something the user may want to step in for, though nothing waits on them:
 * a command that is hard to take back, an answer that ends in a question, a
 * context about to be compacted. Requests that block the agent are
 * attention items instead; findings are the quieter tier below them.
 */
export interface StageFinding {
  readonly id: string;
  readonly kind: "risky" | "question" | "context";
  /** The agent it is about, so the stage can badge its sprite. */
  readonly agentId: string;
  readonly title: string;
  readonly detail: string | null;
  readonly since: string;
}

const RISKY_COMMANDS: ReadonlyArray<{ readonly pattern: RegExp; readonly title: string }> = [
  { pattern: /\brm\s+-[a-z]*(r[a-z]*f|f[a-z]*r)/i, title: "Deletes files recursively" },
  { pattern: /\bgit\s+push\b.*(\s--force\b|\s-f\b|--force-with-lease)/, title: "Force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, title: "Hard reset" },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, title: "Removes untracked files" },
  { pattern: /\bgit\s+branch\s+-D\b/, title: "Deletes a branch" },
  { pattern: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, title: "Drops data" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+publish\b/, title: "Publishes a package" },
  { pattern: /\bmigrate\s+(deploy|reset)\b|\bdb\s+push\b/, title: "Changes a database schema" },
  {
    pattern: /\bterraform\s+(apply|destroy)\b|\bkubectl\s+delete\b/,
    title: "Changes infrastructure",
  },
  { pattern: /(^|[;&|]\s*)sudo\s/, title: "Runs as root" },
];

/** What makes a shell command hard to take back, or null when nothing does. */
export function riskyCommandTitle(command: string | null | undefined): string | null {
  if (!command) return null;
  for (const { pattern, title } of RISKY_COMMANDS) {
    if (pattern.test(command)) return title;
  }
  return null;
}

/**
 * The question an answer leaves the user with: the last sentence of its last
 * paragraph that ends in a question mark. Agents often end a turn by asking
 * in prose, which no request tracks, so nothing else says they are waiting.
 */
export function trailingQuestion(text: string): string | null {
  const paragraphs = text
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const last = paragraphs.at(-1);
  if (last === undefined) return null;
  const sentences = last.replace(/\s+/g, " ").match(/[^.!?]*\?+/g) ?? [];
  const question = sentences
    .at(-1)
    ?.replace(/^[\s*_>-]+/, "")
    .trim();
  return question && question.length > 1 ? question : null;
}

/** Share of the context at which compaction is close enough to mention. */
const CONTEXT_FULL = 0.85;

/**
 * How full the main agent's context is, against the point where the provider
 * compacts it when it says so, else against the window itself.
 */
export function contextFinding(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  agentId: string,
): StageFinding | null {
  const snapshot = deriveLatestContextWindowSnapshot(activities);
  if (snapshot === null) return null;
  const compactAt = snapshot.compactsAutomatically ? (snapshot.autoCompactThreshold ?? null) : null;
  const limit = compactAt ?? snapshot.maxTokens ?? null;
  if (limit === null || limit <= 0) return null;
  const fill = snapshot.usedTokens / limit;
  if (fill < CONTEXT_FULL) return null;
  return {
    id: `context:${agentId}`,
    kind: "context",
    agentId,
    title:
      compactAt !== null
        ? "Context is about to be compacted"
        : `Context ${Math.min(100, Math.round(fill * 100))}% full`,
    detail: "A good moment to wrap up or start a fresh thread.",
    since: snapshot.updatedAt,
  };
}
