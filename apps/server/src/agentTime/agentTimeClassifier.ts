/**
 * Fork: which agent-time category a turn item belongs to.
 *
 * Shell commands are matched by what they run, anywhere in the command line,
 * so `cd repo && npx vitest run` counts as tests. The more expensive kinds of
 * work are checked first: a command that both builds and commits counts as a
 * build.
 *
 * @module agentTimeClassifier
 */
import type { AgentTimeCategory } from "@t3tools/contracts";

// A word boundary that also accepts shell punctuation and quotes.
const W = String.raw`(?:^|[\s;&|()"'\`/=])`;
const E = String.raw`(?=$|[\s;&|()"'\`])`;

const TESTS = new RegExp(
  [
    String.raw`${W}(?:vitest|jest|pytest|mocha|phpunit|rspec|playwright\s+test)${E}`,
    String.raw`${W}(?:vp|npm|pnpm|yarn|bun|deno|go|cargo|dotnet|mix)\s+(?:run\s+)?test(?::\S*)?${E}`,
    String.raw`${W}vpr\s+test${E}`,
  ].join("|"),
);

const BUILD = new RegExp(
  [
    String.raw`${W}(?:tsc|tsgo|vue-tsc|eslint|oxlint|prettier|biome|knip|esbuild|webpack|rollup|turbo|make|gradle|mvn)${E}`,
    String.raw`${W}(?:vp|vpr|npm|pnpm|yarn|bun|cargo|go|dotnet)\s+(?:run\s+)?(?:build|lint|fmt|format|check|typecheck|tsc|compile)(?::\S*)?${E}`,
    String.raw`${W}vite\s+build${E}`,
    String.raw`${W}(?:vp|npm|pnpm|yarn|bun|pip3?|uv|brew|cargo|composer)\s+(?:i|install|add|ci|sync)${E}`,
    String.raw`${W}pnpm@\S+\s+install${E}`,
  ].join("|"),
);

const DATABASE = new RegExp(
  String.raw`${W}(?:sqlite3|mysql|mysqldump|mariadb|psql|pg_dump|mongosh|redis-cli|clickhouse(?:-client)?|prisma|drizzle-kit|knex|migrate|migrate-dev-db)${E}`,
);

const BROWSER = new RegExp(
  String.raw`${W}(?:playwright|puppeteer|screencapture|chromium|google-chrome|agent-browser)${E}|screenshot`,
  "i",
);

const GIT_CI = new RegExp(String.raw`${W}(?:git|gh)\s`);

const WAITING = new RegExp(
  [
    String.raw`${W}sleep\s`,
    String.raw`${W}(?:until|while)\s[\s\S]*${W}sleep${E}`,
    String.raw`${W}wait${E}`,
  ].join("|"),
);

/** Commands that only read, search, or shuffle files. */
const FILE_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "rg",
  "sed",
  "awk",
  "find",
  "fd",
  "ls",
  "wc",
  "diff",
  "cut",
  "sort",
  "uniq",
  "tr",
  "jq",
  "echo",
  "printf",
  "pwd",
  "cd",
  "tree",
  "stat",
  "file",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "xargs",
  "less",
  "realpath",
  "basename",
  "dirname",
  "export",
  "nl",
  "column",
  "test",
  "[",
  "true",
  "source",
  "nvm",
  "ln",
  "chmod",
  "readlink",
  "base64",
  "shasum",
  "md5",
]);

function isFileOnlyCommand(command: string): boolean {
  const segments = command.split(/&&|\|\||[;|\n]/);
  let sawCommand = false;
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/);
    // Skip leading `FOO=bar` assignments and grouping.
    const word = words.find(
      (candidate) => !/^\w+=/.test(candidate) && candidate !== "(" && candidate !== "{",
    );
    if (word === undefined || word.length === 0 || word === ")" || word === "}") continue;
    const name = word.replace(/^[({]+/, "");
    if (name.length === 0 || name.startsWith("#")) continue;
    if (!FILE_COMMANDS.has(name)) return false;
    sawCommand = true;
  }
  return sawCommand;
}

/** The category of a shell command line. */
export function classifyCommand(command: string): AgentTimeCategory {
  if (TESTS.test(command)) return "tests";
  if (BUILD.test(command)) return "build";
  if (DATABASE.test(command)) return "database";
  if (BROWSER.test(command)) return "browser";
  if (GIT_CI.test(command)) return "gitCi";
  if (WAITING.test(command)) return "waiting";
  if (isFileOnlyCommand(command)) return "files";
  return "jobs";
}

const FILE_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "NotebookRead",
  "LS",
]);

const BROWSER_TOOL =
  /preview_|browser|playwright|puppeteer|screenshot|cua-driver|computer|chrome|html_preview|html_render|device_/i;

/** The category of a provider tool call other than a shell command. */
export function classifyTool(toolName: string): AgentTimeCategory {
  if (FILE_TOOLS.has(toolName)) return "files";
  if (BROWSER_TOOL.test(toolName)) return "browser";
  if (toolName.endsWith("t3_thread_wait")) return "children";
  return "otherTools";
}

export interface ClassifiableItem {
  readonly type: string;
  readonly toolName?: string | null | undefined;
  readonly command?: string | null | undefined;
}

/**
 * The category of a turn item's own span, or null for items that take no time
 * of their own (messages, checkpoints, notifications).
 */
export function classifyItem(item: ClassifiableItem): AgentTimeCategory | null {
  switch (item.type) {
    case "reasoning":
      return "modelThinking";
    case "command_execution":
      return classifyCommand(item.command ?? "");
    case "dynamic_tool":
    case "mcp_tool_call":
      return classifyTool(item.toolName ?? "");
    case "file_change":
      return "files";
    case "web_search":
      return "otherTools";
    case "compaction":
    case "error":
      return "compactionErrors";
    case "subagent":
      return "children";
    case "user_input_request":
      return "idle";
    default:
      return null;
  }
}
