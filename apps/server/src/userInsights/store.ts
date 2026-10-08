/**
 * Fork: user insights. The files in `<stateDir>/user-insights/`. Reads are
 * tolerant: a missing or corrupt file or line reads as empty with a warning,
 * never as a failure. Callers serialize access (the service holds one lock).
 */
import { UserInsightsError, UserInsightsProfile } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { UserInsightsState } from "./distillPolicy.ts";
import { EvidenceRecord } from "./evidence.ts";
import { DAY_MS, fromIso } from "./time.ts";

export const USER_INSIGHTS_DIRECTORY = "user-insights";
export const EVIDENCE_MAX_RECORDS = 500;
export const EVIDENCE_MAX_AGE_DAYS = 30;
export const LEDGER_MAX_AGE_DAYS = 90;

export const UsageRecord = Schema.Struct({
  ts: Schema.String,
  purpose: Schema.Literals(["distill", "suggest"]),
  model: Schema.String,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheCreationTokens: Schema.Number,
  costUsd: Schema.Number,
  /** The CLI reported no cost, so it was estimated from tokens. */
  costEstimated: Schema.Boolean,
  durationMs: Schema.Number,
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
export type UsageRecord = typeof UsageRecord.Type;

export const FeedbackRecord = Schema.Struct({
  ts: Schema.String,
  threadId: Schema.String,
  setId: Schema.String,
  labels: Schema.Array(Schema.String),
  outcome: Schema.Literals(["accepted", "edited", "dismissed", "ignored"]),
  index: Schema.optionalKey(Schema.Number),
});
export type FeedbackRecord = typeof FeedbackRecord.Type;

const failure = (message: string) => () => new UserInsightsError({ message });

/** Opens the folder below `stateDir`. Nothing touches the disk until a method runs. */
export const makeUserInsightsStore = Effect.fn("makeUserInsightsStore")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, USER_INSIGHTS_DIRECTORY);
  const files = {
    evidence: path.join(directory, "evidence.jsonl"),
    profile: path.join(directory, "profile.json"),
    profilePrev: path.join(directory, "profile.prev.json"),
    usage: path.join(directory, "usage.jsonl"),
    feedback: path.join(directory, "feedback.jsonl"),
    state: path.join(directory, "state.json"),
  };

  const readText = (file: string) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(""))),
      Effect.catch((cause) =>
        Effect.logWarning("user-insights.read-failed", { file, cause }).pipe(Effect.as("")),
      ),
    );

  const readJson = <S extends Schema.Codec<unknown, unknown>>(file: string, schema: S) =>
    readText(file).pipe(
      Effect.flatMap((text) => {
        if (text.trim().length === 0) return Effect.succeed<S["Type"] | null>(null);
        return Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("user-insights.corrupt-file", { file, cause }).pipe(Effect.as(null)),
          ),
        );
      }),
    );

  const readJsonl = <S extends Schema.Codec<unknown, unknown>>(file: string, schema: S) => {
    const decodeLine = Schema.decodeOption(Schema.fromJsonString(schema));
    return readText(file).pipe(
      Effect.flatMap((text) => {
        const records: Array<S["Type"]> = [];
        let corrupt = 0;
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          const decoded = decodeLine(line);
          if (decoded._tag === "Some") records.push(decoded.value);
          else corrupt += 1;
        }
        return corrupt === 0
          ? Effect.succeed(records)
          : Effect.logWarning("user-insights.corrupt-lines", { file, corrupt }).pipe(
              Effect.as(records),
            );
      }),
    );
  };

  const ensureDirectory = fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(failure("Could not create the user insights folder.")));

  const writeJson = <S extends Schema.Codec<unknown, unknown>>(
    file: string,
    schema: S,
    value: S["Type"],
  ) =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(failure("Could not encode user insights data.")),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: file, contents: `${contents}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(failure("Could not save user insights data.")),
        ),
      ),
    );

  const writeJsonl = <S extends Schema.Codec<unknown, unknown>>(
    file: string,
    schema: S,
    records: ReadonlyArray<S["Type"]>,
  ) =>
    Effect.forEach(records, (record) =>
      Schema.encodeEffect(Schema.fromJsonString(schema))(record),
    ).pipe(
      Effect.mapError(failure("Could not encode user insights data.")),
      Effect.flatMap((lines) =>
        writeFileStringAtomically({
          filePath: file,
          contents: lines.map((line) => `${line}\n`).join(""),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError(failure("Could not save user insights data.")),
        ),
      ),
    );

  const append = <S extends Schema.Codec<unknown, unknown>>(
    file: string,
    schema: S,
    record: S["Type"],
  ) =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(record).pipe(
      Effect.mapError(failure("Could not encode user insights data.")),
      Effect.flatMap((line) =>
        ensureDirectory.pipe(
          Effect.andThen(
            fs
              .writeFileString(file, `${line}\n`, { flag: "a" })
              .pipe(Effect.mapError(failure("Could not save user insights data."))),
          ),
        ),
      ),
    );

  const remove = (file: string) =>
    fs
      .remove(file, { force: true })
      .pipe(Effect.mapError(failure("Could not delete user insights data.")));

  const youngerThan = (days: number, now: number) => (record: { readonly ts: string }) =>
    now - fromIso(record.ts) <= days * DAY_MS;

  return {
    directory,
    files,
    /** Whether the folder is there; a failed check reads as there, so it can still be deleted. */
    exists: fs.exists(directory).pipe(Effect.orElseSucceed(() => true)),
    readProfile: readJson(files.profile, UserInsightsProfile),
    readPreviousProfile: readJson(files.profilePrev, UserInsightsProfile),
    /** Saves the profile and keeps the one it replaces as `profile.prev.json`. */
    writeProfile: (profile: UserInsightsProfile) =>
      Effect.gen(function* () {
        const current = yield* readText(files.profile);
        if (current.trim().length > 0) {
          yield* writeFileStringAtomically({ filePath: files.profilePrev, contents: current }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(failure("Could not save user insights data.")),
          );
        }
        yield* writeJson(files.profile, UserInsightsProfile, profile);
      }),
    /** Puts `profile.prev.json` back; false when there is none. */
    restorePreviousProfile: Effect.gen(function* () {
      const previous = yield* readJson(files.profilePrev, UserInsightsProfile);
      if (previous === null) return false;
      yield* writeJson(files.profile, UserInsightsProfile, previous);
      yield* remove(files.profilePrev);
      return true;
    }),
    readState: readJson(files.state, UserInsightsState),
    writeState: (state: UserInsightsState) => writeJson(files.state, UserInsightsState, state),
    readEvidence: readJsonl(files.evidence, EvidenceRecord),
    appendEvidence: (record: EvidenceRecord) => append(files.evidence, EvidenceRecord, record),
    readUsage: readJsonl(files.usage, UsageRecord),
    appendUsage: (record: UsageRecord) => append(files.usage, UsageRecord, record),
    readFeedback: readJsonl(files.feedback, FeedbackRecord),
    appendFeedback: (record: FeedbackRecord) => append(files.feedback, FeedbackRecord, record),
    /**
     * Keeps the newest 500 evidence records of the last 30 days, and 90 days
     * of usage and feedback. Files that need no trimming are left alone.
     */
    trim: (now: number) =>
      Effect.gen(function* () {
        const evidence = yield* readJsonl(files.evidence, EvidenceRecord);
        const keptEvidence = evidence
          .filter(youngerThan(EVIDENCE_MAX_AGE_DAYS, now))
          .slice(-EVIDENCE_MAX_RECORDS);
        if (keptEvidence.length !== evidence.length) {
          yield* writeJsonl(files.evidence, EvidenceRecord, keptEvidence);
        }
        const usage = yield* readJsonl(files.usage, UsageRecord);
        const keptUsage = usage.filter(youngerThan(LEDGER_MAX_AGE_DAYS, now));
        if (keptUsage.length !== usage.length) {
          yield* writeJsonl(files.usage, UsageRecord, keptUsage);
        }
        const feedback = yield* readJsonl(files.feedback, FeedbackRecord);
        const keptFeedback = feedback.filter(youngerThan(LEDGER_MAX_AGE_DAYS, now));
        if (keptFeedback.length !== feedback.length) {
          yield* writeJsonl(files.feedback, FeedbackRecord, keptFeedback);
        }
      }),
    /** Forgets everything learned; the usage ledger stays. */
    reset: Effect.forEach(
      [files.evidence, files.profile, files.profilePrev, files.feedback, files.state],
      remove,
      { discard: true },
    ),
    deleteAll: fs
      .remove(directory, { recursive: true, force: true })
      .pipe(Effect.mapError(failure("Could not delete the user insights folder."))),
  };
});

export type UserInsightsStore = Effect.Success<ReturnType<typeof makeUserInsightsStore>>;
