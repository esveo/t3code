/**
 * Fork: one- or two-sentence summaries of imported sessions, from Claude
 * Code's CLI with its smallest model, the way the server writes thread titles:
 * no tools, no hooks, no MCP servers, in an empty folder. The CLI reports what
 * a call cost, which the import counts against its cap.
 */
import { InitiativesError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { Summarize } from "./InitiativeImport.ts";

const failure = (message: string) => new InitiativesError({ message });

const CliResult = Schema.Struct({
  result: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  total_cost_usd: Schema.optional(Schema.Number),
});
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(CliResult));

export const SUMMARY_MODEL = "haiku";

export const makeClaudeSummarizer = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const summarize: Summarize = (prompt) =>
    Effect.scoped(
      Effect.gen(function* () {
        const claude = (yield* settings.getSettings.pipe(
          Effect.mapError(() => failure("Could not read the settings.")),
        )).providers.claudeAgent;
        const env = yield* makeClaudeEnvironment(claude).pipe(
          Effect.provideService(Path.Path, path),
        );
        const cwd = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3code-initiative-summary-" })
          .pipe(Effect.mapError(() => failure("Could not create a folder for the summary.")));
        const output = yield* runner
          .run({
            command: claude.binaryPath || "claude",
            args: [
              "-p",
              "--output-format",
              "json",
              "--model",
              SUMMARY_MODEL,
              "--settings",
              '{"disableAllHooks":true}',
              "--tools",
              "",
              "--disable-slash-commands",
              "--strict-mcp-config",
              "--permission-mode",
              "dontAsk",
            ],
            cwd,
            env: env as Record<string, string>,
            stdin: prompt,
            timeout: "120 seconds",
          })
          .pipe(
            Effect.mapError((error) => failure(`Claude could not summarize: ${error.message}`)),
          );
        const result = Option.getOrNull(decodeResult(output.stdout.trim()));
        if (!result || result.is_error || !result.result?.trim()) {
          return yield* failure(
            `Claude could not summarize: ${(output.stderr || output.stdout).trim().split("\n")[0] ?? "no answer"}`,
          );
        }
        return { text: result.result.trim(), costUsd: result.total_cost_usd ?? 0 };
      }),
    );
  return summarize;
});
