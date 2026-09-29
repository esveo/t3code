/**
 * The preflight: fixed rules that sort an approval request into a row of the
 * approval matrix and say what they would have answered. In shadow mode that
 * answer is only recorded and compared with the user's click; nothing is
 * sent. Rules only ever look at the action, never at text an agent wrote to
 * argue for it, and a provider's own warning always means "ask".
 */
import type {
  InitiativeApprovalObservation,
  PreflightProviderStats,
  PreflightVerdict,
  PreflightWouldHave,
} from "@t3tools/contracts";

export const PREFLIGHT_RULE_VERSION = "rules-1";

export interface PreflightAction {
  readonly tool: string | null;
  readonly command: string | null;
  readonly paths: ReadonlyArray<string>;
  readonly detail: string | null;
  /** The masked input, cut to a readable size. */
  readonly input: string | null;
}

// ── Reading the action ────────────────────────────────────────────────────

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|auth)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;]+)/gi;

/** The text with anything that looks like a secret replaced by ***. */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) masked = masked.replace(pattern, "***");
  return masked.replace(
    SECRET_ASSIGNMENT,
    (_match, key: string, separator: string) => `${key}${separator}***`,
  );
}

const INPUT_LIMIT = 2000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringOf = (value: unknown): string | null => {
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return null;
};

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target", "cwd"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const TOOL_KEYS = ["tool_name", "toolName", "tool", "name", "server"];

/** Tool, command and paths of a request, from the provider's `args` whatever their shape. */
export function readAction(input: {
  readonly detail?: string | undefined;
  readonly args?: unknown;
}): PreflightAction {
  const args = asRecord(input.args);
  const nested =
    asRecord(args?.["input"]) ?? asRecord(args?.["arguments"]) ?? asRecord(args?.["params"]);
  const sources = [args, nested].filter(
    (source): source is Record<string, unknown> => source !== null,
  );
  let tool: string | null = null;
  let command: string | null = null;
  const paths = new Set<string>();
  for (const source of sources) {
    for (const key of TOOL_KEYS) tool ??= stringOf(source[key]);
    for (const key of COMMAND_KEYS) command ??= stringOf(source[key]);
    for (const key of PATH_KEYS) {
      const value = source[key];
      if (typeof value === "string" && value.trim() && key !== "cwd") paths.add(value);
    }
    const changes = source["changes"] ?? source["files"];
    if (Array.isArray(changes)) {
      for (const change of changes) {
        const record = asRecord(change);
        const path =
          typeof change === "string" ? change : stringOf(record?.["path"] ?? record?.["file_path"]);
        if (path) paths.add(path);
      }
    } else if (asRecord(changes)) {
      for (const path of Object.keys(asRecord(changes)!)) paths.add(path);
    }
  }
  let serialized: string | null = null;
  if (input.args !== undefined) {
    try {
      serialized = JSON.stringify(input.args);
    } catch {
      serialized = null;
    }
  }
  const masked = serialized ? maskSecrets(serialized) : null;
  return {
    tool,
    command: command ? maskSecrets(command) : null,
    paths: [...paths],
    detail: input.detail ? maskSecrets(input.detail) : null,
    input: masked && masked.length > INPUT_LIMIT ? `${masked.slice(0, INPUT_LIMIT)}…` : masked,
  };
}

/** What identifies the action unchanged: the request type and its masked content. */
export function actionFingerprint(requestType: string, action: PreflightAction): string {
  return JSON.stringify([requestType, action.tool, action.command, action.paths, action.input]);
}

// ── Rules ───────────────────────────────────────────────────────────────

export interface RuleContext {
  readonly requestType: string;
  readonly action: PreflightAction;
  /** Where the thread works; edits inside it are its own. */
  readonly workspaceRoot: string | null;
  readonly warnings: ReadonlyArray<string>;
}

type RuleResult = Pick<PreflightVerdict, "ruleHit" | "category" | "wouldHave" | "reason">;

const rule = (
  ruleHit: string,
  category: string,
  wouldHave: PreflightWouldHave,
  reason: string,
): RuleResult => ({
  ruleHit,
  category,
  wouldHave,
  reason,
});

const MONEY =
  /\b(stripe|paypal|adyen|klarna)\b[\s\S]*\b(charge|payment|payout|refund|transfer)s?\b|\b(ibkr|alpaca|trade republic|scalable)\b[\s\S]*\b(order|buy|sell|trade)\b/i;
const DELETE =
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+|\bgit\s+(clean\s+-[a-z]*f|reset\s+--hard|push\s+[^\n]*(--force|-f)\b|branch\s+-D)|\b(drop|truncate)\s+(table|database|schema)\b|\bdelete\s+from\b/i;
const DEPENDENCY =
  /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\s+[^-\s]|\bnpx\s+(pnpm@[^\s]+\s+)?add\b|\bpip3?\s+install\s+[^-\s]|\bcargo\s+add\b|\bbrew\s+install\b|\bgo\s+get\b|\bgem\s+install\b/i;
const OUTWARD =
  /\b(curl|wget|http|httpie)\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|--form|-F\s)|\bgh\s+(pr|issue)\s+(comment|create|close|merge|review)|\bgh\s+api\s+[^\n]*(-X\s*(POST|PATCH|PUT|DELETE)|--method\s+(POST|PATCH|PUT|DELETE)|-f\s)|\b(sendmail|mail|mutt)\b|\bslack\b|\bnpm\s+publish\b/i;
const PUSH = /\bgit\s+push\b/i;
const MAIN_BRANCH = /\b(main|master|fork|production|release)\b/;
const READ_ONLY =
  /^(\s*(cd\s+[^;&|]+\s*(&&|;)\s*)?(ls|cat|head|tail|wc|rg|grep|find|fd|tree|pwd|echo|which|file|stat|du|df|date|env|printenv|git\s+(status|log|diff|show|branch|rev-parse|remote\s+-v|blame|ls-files)|node\s+-v|npx\s+tsc\s+--noEmit|sed\s+-n)\b[^>]*)$/i;
const DESIGN_TOOLS = /(figma|use_figma|create_new_file|designsync|claude_design|generate_diagram)/i;
const IMAGE_TOOLS =
  /(generate_image|generate_video|image_generation|higgsfield|imagegen|gpt-image)/i;
const OUTWARD_TOOLS =
  /(notion|slack|gmail|mail|send_message|post|publish|create_comment|create_page|update_page)/i;
const PROTECTED_PATH = /(^|\/)\.git(\/|$)|(^|\/)\.github\/workflows\/|(^|\/)(\.husky|hooks)\//;

const isInside = (path: string, root: string | null) => {
  if (!root) return false;
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return !path.startsWith("/") ? !path.split("/").includes("..") : path.startsWith(normalizedRoot);
};

/**
 * The fixed rules, strictest first. A command no rule knows is never
 * accepted: without a hit the answer is "ask".
 */
export function classifyRequest(context: RuleContext): RuleResult {
  const { action, requestType } = context;
  const text = [action.command, action.tool, action.detail, action.input].filter(Boolean).join(" ");
  if (context.warnings.length > 0) {
    return rule("provider-warning", "warning", "ask", `The provider warns: ${context.warnings[0]}`);
  }
  if (MONEY.test(text))
    return rule("money", "money", "decline", "Spending money or trading is forbidden.");
  if (action.tool && IMAGE_TOOLS.test(action.tool)) {
    return rule(
      "image-credits",
      "image-credits",
      "ask",
      "Image or video generation spends credits.",
    );
  }
  if (action.tool && DESIGN_TOOLS.test(action.tool)) {
    return rule(
      "design-write",
      "design-write",
      "ask",
      "Writing to Figma or Claude Design asks first.",
    );
  }
  if (
    action.tool &&
    requestType === "mcp_elicitation_approval" &&
    OUTWARD_TOOLS.test(action.tool)
  ) {
    return rule("outward-tool", "outward", "ask", "Sending to the outside world asks first.");
  }
  if (DELETE.test(text))
    return rule("delete-data", "delete-data", "ask", "Deleting data asks first.");
  if (DEPENDENCY.test(text))
    return rule("new-dependency", "new-dependency", "ask", "A new dependency asks first.");
  if (
    action.paths.some((path) =>
      /(^|\/)(package\.json|requirements\.txt|Cargo\.toml|go\.mod|Gemfile)$/.test(path),
    )
  ) {
    return rule(
      "manifest-edit",
      "new-dependency",
      "ask",
      "Changing a dependency manifest asks first.",
    );
  }
  if (OUTWARD.test(text))
    return rule("outward", "outward", "ask", "Sending to the outside world asks first.");
  if (action.command && PUSH.test(action.command)) {
    return MAIN_BRANCH.test(action.command)
      ? rule(
          "merge-main",
          "merge-main",
          "accept",
          "Pushing to a main branch: allowed, and reported.",
        )
      : rule("own-branch-push", "own-branch-code", "accept", "Pushing the thread's own branch.");
  }
  if (requestType === "file_change_approval" || requestType === "apply_patch_approval") {
    if (action.paths.length === 0)
      return rule("edit-unknown-path", "own-branch-code", "ask", "The change names no file.");
    if (action.paths.some((path) => PROTECTED_PATH.test(path))) {
      return rule(
        "protected-path",
        "own-branch-code",
        "ask",
        "Git internals, hooks and CI workflows ask first.",
      );
    }
    return action.paths.every((path) => isInside(path, context.workspaceRoot))
      ? rule(
          "own-worktree-edit",
          "own-branch-code",
          "accept",
          "An edit inside the thread's own worktree.",
        )
      : rule("outside-edit", "own-branch-code", "ask", "An edit outside the thread's worktree.");
  }
  if (requestType === "file_read_approval") {
    return action.paths.every((path) => isInside(path, context.workspaceRoot)) &&
      action.paths.length > 0
      ? rule("own-worktree-read", "read", "accept", "Reading inside the thread's worktree.")
      : rule("outside-read", "read", "ask", "Reading outside the thread's worktree.");
  }
  if (
    action.command &&
    READ_ONLY.test(action.command.trim()) &&
    !/[;&|]\s*\S/.test(action.command.replace(/^\s*cd\s+[^;&|]+\s*(&&|;)/, ""))
  ) {
    return rule("read-only-command", "read", "accept", "A command that only reads.");
  }
  if (action.command)
    return rule("no-rule", "unknown", "ask", "No rule knows this command, so it asks.");
  return rule("no-rule", "unknown", "ask", "No rule covers this request, so it asks.");
}

/** A decision the user or provider gave, as accept or decline. */
export function answerOf(decision: string | null): "accept" | "decline" | null {
  if (decision === null) return null;
  if (decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways")
    return "accept";
  if (decision === "decline" || decision === "cancel") return "decline";
  return null;
}

// ── Coverage and measurement ─────────────────────────────────────────────

/**
 * What each provider's own "auto" mode covers, as far as T3 knows it; the
 * numbers the preflight records show what reaches the user despite it.
 */
export const PROVIDER_COVERAGE: Record<
  string,
  { readonly autoReviewer: boolean; readonly note: string }
> = {
  codex: { autoReviewer: true, note: "auto_review prüft Befehle außerhalb der Sandbox" },
  claudeAgent: { autoReviewer: true, note: "Claudes eingebaute Prüfung im Modus auto" },
  cursor: { autoReviewer: true, note: "Cursors eingebaute Prüfung" },
  grok: { autoReviewer: true, note: "Groks eingebaute Prüfung" },
  opencode: { autoReviewer: false, note: "kein Prüfer: Auto-accept edits, Befehle fragen" },
  antigravity: { autoReviewer: false, note: "kein Prüfer: Auto-accept edits, Befehle fragen" },
};

/**
 * Per provider: how many requests, how many the user answered (in auto mode:
 * what landed on them despite it), per hour, and how the verdicts compare
 * with the user's answers.
 */
export function preflightStats(
  observations: ReadonlyArray<InitiativeApprovalObservation>,
  /** Rolled-back work per provider, from rollbackReport. */
  rollbacks?: ReadonlyMap<string, { readonly rolledBack: number; readonly base: number }>,
): ReadonlyArray<PreflightProviderStats> {
  const byProvider = new Map<string, Array<InitiativeApprovalObservation>>();
  for (const observation of observations) {
    const list = byProvider.get(observation.provider) ?? [];
    list.push(observation);
    byProvider.set(observation.provider, list);
  }
  return [...byProvider.entries()]
    .map(([provider, list]) => {
      const opened = list
        .map((observation) => Date.parse(observation.openedAt))
        .filter(Number.isFinite);
      const hours = opened.length > 1 ? (Math.max(...opened) - Math.min(...opened)) / 3_600_000 : 0;
      let agreed = 0;
      let wrongAccepts = 0;
      let needlessAsks = 0;
      let byPerson = 0;
      let inAutoMode = 0;
      for (const observation of list) {
        if (observation.resolvedBy !== "person") continue;
        byPerson += 1;
        if (observation.runtimeMode === "auto") inAutoMode += 1;
        const answer = answerOf(observation.decision);
        const verdict = observation.verdicts[0]?.wouldHave;
        if (!answer || !verdict) continue;
        if (verdict === answer) agreed += 1;
        else if (verdict === "accept" && answer === "decline") wrongAccepts += 1;
        else if (verdict === "ask" && answer === "accept") needlessAsks += 1;
      }
      return {
        provider,
        requests: list.length,
        byPerson,
        inAutoMode,
        perHour: hours >= 1 ? Math.round((list.length / hours) * 10) / 10 : null,
        agreed,
        wrongAccepts,
        needlessAsks,
        markedWrong: list.filter((observation) => observation.markedWrongBy !== null).length,
        rolledBack: rollbacks?.get(provider)?.rolledBack ?? 0,
        rollbackBase: rollbacks?.get(provider)?.base ?? 0,
      };
    })
    .toSorted((a, b) => b.requests - a.requests);
}

export * from "./evidence.ts";
