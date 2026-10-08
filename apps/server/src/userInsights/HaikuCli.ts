/**
 * Fork: user insights. Runs one structured Claude Haiku call through the
 * Claude CLI and reports what it cost. A fork-owned runner instead of a new
 * `TextGeneration` operation: upstream's runner drops the usage the ledger
 * needs, and adding an operation would touch every provider.
 *
 * Calls run without tools, hooks, MCP or slash commands, in an empty temp
 * directory, and with `--no-session-persistence`, so the user's excerpts are
 * not kept as Claude transcripts.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { toJsonSchemaObject } from "../textGeneration/TextGenerationUtils.ts";

export const USER_INSIGHTS_MODEL = "claude-haiku-4-5";
export const MAX_BUDGET_PER_CALL_USD = 0.05;
export const CALL_TIMEOUT_MS = 120_000;
/** Haiku 4.5 list prices per token, for when the CLI reports no cost. */
const INPUT_USD_PER_TOKEN = 1 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 5 / 1_000_000;
const CACHE_READ_USD_PER_TOKEN = 0.1 / 1_000_000;
const CACHE_WRITE_USD_PER_TOKEN = 1.25 / 1_000_000;

export interface ModelUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly costEstimated: boolean;
  readonly durationMs: number;
}

export const emptyUsage = (durationMs = 0): ModelUsage => ({
  model: USER_INSIGHTS_MODEL,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  costEstimated: true,
  durationMs,
});

export class UserInsightsModelError extends Data.TaggedError("UserInsightsModelError")<{
  /** `unavailable`: Claude is turned off, so no call was made. */
  readonly reason: "unavailable" | "failed";
  readonly message: string;
  /** What the failed call cost, when the CLI got far enough to say. */
  readonly usage: ModelUsage | null;
}> {}

const Usage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
});

const ResultEntry = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.Unknown),
  structured_output: Schema.optionalKey(Schema.Unknown),
  total_cost_usd: Schema.optionalKey(Schema.Number),
  duration_ms: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(Usage),
});
const decodeEnvelope = Schema.decodeOption(
  Schema.fromJsonString(Schema.Union([ResultEntry, Schema.Array(ResultEntry)])),
);

export interface ParsedClaudeResult {
  readonly structuredOutput: unknown;
  readonly isError: boolean;
  readonly errorText: string | null;
  readonly usage: ModelUsage;
}

/**
 * Reads the `--output-format json` envelope: an object, or an array whose
 * last `type: "result"` entry counts. Usage fields are optional; a missing
 * cost is estimated from the tokens. Null when stdout is not an envelope.
 */
export function parseClaudeResult(stdout: string): ParsedClaudeResult | null {
  const decoded = decodeEnvelope(stdout.trim());
  if (Option.isNone(decoded)) return null;
  const envelope = Array.isArray(decoded.value)
    ? decoded.value.findLast((entry) => entry.type === "result")
    : decoded.value;
  if (envelope === undefined) return null;
  const usage = envelope.usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const reportedCost = envelope.total_cost_usd;
  const costUsd =
    reportedCost ??
    inputTokens * INPUT_USD_PER_TOKEN +
      outputTokens * OUTPUT_USD_PER_TOKEN +
      cacheReadTokens * CACHE_READ_USD_PER_TOKEN +
      cacheCreationTokens * CACHE_WRITE_USD_PER_TOKEN;
  const isError = envelope.is_error === true || envelope.subtype?.startsWith("error") === true;
  return {
    structuredOutput: envelope.structured_output,
    isError,
    errorText: isError
      ? typeof envelope.result === "string" && envelope.result.length > 0
        ? envelope.result
        : (envelope.subtype ?? "error")
      : null,
    usage: {
      model: USER_INSIGHTS_MODEL,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      costUsd,
      costEstimated: reportedCost === undefined,
      durationMs: envelope.duration_ms ?? 0,
    },
  };
}

export interface ModelRequest<S extends Schema.Top> {
  readonly prompt: string;
  readonly outputSchema: S;
}

export class UserInsightsModel extends Context.Service<
  UserInsightsModel,
  {
    /** One Haiku call with structured output; the usage comes back either way. */
    readonly run: <S extends Schema.Top>(
      request: ModelRequest<S>,
    ) => Effect.Effect<
      { readonly output: S["Type"]; readonly usage: ModelUsage },
      UserInsightsModelError,
      S["DecodingServices"]
    >;
  }
>()("t3/userInsights/HaikuCli/UserInsightsModel") {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const failed = (message: string, usage: ModelUsage | null = null) =>
    new UserInsightsModelError({ reason: "failed", message, usage });

  const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError(() => failed("Could not read the Claude CLI output.")),
    );

  const run: UserInsightsModel["Service"]["run"] = (request) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => failed("Could not read the settings.")),
      );
      const claude = settings.providers.claudeAgent;
      if (!claude.enabled) {
        return yield* new UserInsightsModelError({
          reason: "unavailable",
          message: "Claude is turned off.",
          usage: null,
        });
      }
      const environment = yield* makeClaudeEnvironment(claude).pipe(
        Effect.provideService(Path.Path, path),
      );
      const schemaJson = yield* encodeJson(toJsonSchemaObject(request.outputSchema)).pipe(
        Effect.mapError(() => failed("Could not encode the output schema.")),
      );
      const stdout = yield* Effect.gen(function* () {
        const cwd = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-user-insights-" })
          .pipe(Effect.mapError(() => failed("Could not create a working directory.")));
        const spawnCommand = yield* resolveSpawnCommand(
          claude.binaryPath || "claude",
          [
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            schemaJson,
            "--model",
            USER_INSIGHTS_MODEL,
            "--tools",
            "",
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--permission-mode",
            "dontAsk",
            "--no-session-persistence",
            "--max-budget-usd",
            String(MAX_BUDGET_PER_CALL_USD),
            "--settings",
            '{"disableAllHooks":true}',
          ],
          { env: environment },
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              env: environment,
              cwd,
              shell: spawnCommand.shell,
              stdin: { stream: Stream.encodeText(Stream.make(request.prompt)) },
            }),
          )
          .pipe(Effect.mapError(() => failed("Could not start the Claude CLI.")));
        const [out, err, exitCode] = yield* Effect.all(
          [
            collect(child.stdout),
            collect(child.stderr),
            child.exitCode.pipe(Effect.mapError(() => failed("The Claude CLI did not exit."))),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          const parsed = parseClaudeResult(out);
          const detail = parsed?.errorText ?? (err.trim() || out.trim());
          return yield* failed(
            detail.length > 0
              ? `Claude CLI failed: ${detail.slice(0, 300)}`
              : `Claude CLI exited with code ${exitCode}.`,
            parsed?.usage ?? null,
          );
        }
        return out;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(CALL_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(failed("The Claude CLI timed out.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const parsed = parseClaudeResult(stdout);
      if (parsed === null) return yield* failed("The Claude CLI returned unexpected output.");
      if (parsed.isError) {
        return yield* failed(`Claude reported an error: ${parsed.errorText}`, parsed.usage);
      }
      const decodeOutput = Schema.decodeUnknownEffect(request.outputSchema);
      const output = yield* decodeOutput(parsed.structuredOutput).pipe(
        Effect.mapError(() => failed("Claude returned invalid structured output.", parsed.usage)),
      );
      return { output, usage: parsed.usage };
    });

  return UserInsightsModel.of({ run });
});

export const layer = Layer.effect(UserInsightsModel, make);
