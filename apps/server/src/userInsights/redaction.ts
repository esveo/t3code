/**
 * Fork: user insights. Strips secrets and personal identifiers from message
 * text before any of it is stored as evidence or sent to the model.
 */

interface RedactionRule {
  readonly kind: string;
  readonly pattern: RegExp;
  /** Keeps a prefix of the match (such as `password=`) in front of the marker. */
  readonly keepPrefix?: boolean;
}

// Order matters: specific token shapes run before the generic blob rules.
const RULES: ReadonlyArray<RedactionRule> = [
  {
    kind: "PRIVATE_KEY",
    pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  },
  { kind: "JWT", pattern: /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g },
  { kind: "ANTHROPIC_KEY", pattern: /\bsk-ant-[\w-]{10,}/g },
  { kind: "API_KEY", pattern: /\bsk-[\w-]{16,}/g },
  { kind: "GITHUB_TOKEN", pattern: /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g },
  { kind: "AWS_KEY", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "SLACK_TOKEN", pattern: /\bxox[abprs]-[\w-]{10,}/g },
  { kind: "GOOGLE_KEY", pattern: /\bAIza[\w-]{30,}/g },
  {
    kind: "SECRET",
    pattern: /(\b[\w-]*(?:key|token|secret|password|passwd|pwd)\s*[:=]\s*)(?!\[REDACTED)\S+/gi,
    keepPrefix: true,
  },
  { kind: "EMAIL", pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "HEX", pattern: /\b[0-9a-fA-F]{32,}\b/g },
  // Base64 needs a digit and both cases, so long identifiers survive; `/` is
  // left out so file paths do too.
  {
    kind: "BLOB",
    pattern:
      /(?<![\w+/.-])(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])[A-Za-z0-9+]{32,}={0,2}(?![\w+/])/g,
  },
];

/** Replaces every secret-looking span with `[REDACTED:KIND]`. */
export function redact(text: string): string {
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (_match: string, ...groups: Array<unknown>) => {
      if (rule.keepPrefix === true && typeof groups[0] === "string") {
        return `${groups[0]}[REDACTED:${rule.kind}]`;
      }
      return `[REDACTED:${rule.kind}]`;
    });
  }
  return result;
}

/** Longest message that still counts as typed rather than pasted. */
export const MOSTLY_PASTED_MAX_CHARS = 4000;
const MOSTLY_PASTED_FENCED_SHARE = 0.7;

/** Characters inside fenced code blocks; an unclosed fence runs to the end. */
export function fencedCharCount(text: string): number {
  let fenced = 0;
  const fence = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  for (const match of text.matchAll(fence)) fenced += match[0].length;
  return fenced;
}

/**
 * Whether a message is mostly pasted content (logs, code, documents). Such
 * messages say little about how the user writes, so only their features are kept.
 */
export function isMostlyPasted(text: string): boolean {
  if (text.length > MOSTLY_PASTED_MAX_CHARS) return true;
  if (text.length === 0) return false;
  return fencedCharCount(text) / text.length > MOSTLY_PASTED_FENCED_SHARE;
}
