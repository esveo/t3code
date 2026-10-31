/**
 * Fork: esveo code's own count of connected voice call time. OpenAI publishes
 * no usage figure and ChatGPT-app use is invisible here, so this is an estimate.
 * See docs/internals/voice-call.md.
 */
import type { VoiceCallUsage } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

const HOUR_S = 3_600;
const DAY_MS = 86_400_000;
const RETENTION_MS = 35 * DAY_MS;

/**
 * `chatgpt_plan_type` to the rolling 24-hour allowance in OpenAI's GPT-Live FAQ
 * (help.openai.com/en/articles/20001274), which may change. Going by
 * `codexPlanLabel`, `prolite` is the $100 Pro plan and `pro` the $200 one.
 */
const VOICE_CALL_PLANS: ReadonlyMap<
  string,
  { readonly label: string; readonly limitSeconds: number | null }
> = new Map([
  ["free", { label: "Free, no published limit", limitSeconds: null }],
  ["go", { label: "Go", limitSeconds: 3 * HOUR_S }],
  ["plus", { label: "Plus", limitSeconds: 3 * HOUR_S }],
  ["team", { label: "Business", limitSeconds: 3 * HOUR_S }],
  ["business", { label: "Business", limitSeconds: 3 * HOUR_S }],
  ["self_serve_business_usage_based", { label: "Business", limitSeconds: 3 * HOUR_S }],
  ["prolite", { label: "Pro $100", limitSeconds: 15 * HOUR_S }],
  ["pro", { label: "Pro $200, unlimited", limitSeconds: null }],
]);

export const voiceCallPlan = (planType: string | null) => {
  const plan = planType === null ? undefined : VOICE_CALL_PLANS.get(planType);
  return { planLabel: plan?.label ?? null, limitSeconds: plan?.limitSeconds ?? null };
};

const UsageEntries = Schema.Array(
  Schema.Struct({ startedAt: Schema.Number, endedAt: Schema.Number }),
);
type UsageEntries = typeof UsageEntries.Type;
const UsageEntriesJson = Schema.fromJsonString(UsageEntries);
const decodeUsageEntries = Schema.decodeUnknownOption(UsageEntriesJson);
const encodeUsageEntries = Schema.encodeSync(UsageEntriesJson);

export const connectedSeconds = (entries: UsageEntries, sinceMs: number, nowMs: number) =>
  Math.round(
    entries.reduce(
      (sum, entry) =>
        sum + Math.max(0, Math.min(entry.endedAt, nowMs) - Math.max(entry.startedAt, sinceMs)),
      0,
    ) / 1_000,
  );

export const pruneUsageEntries = (entries: UsageEntries, nowMs: number) =>
  entries.filter((entry) => entry.endedAt > nowMs - RETENTION_MS);

/**
 * One segment is open at a time, and it only reaches the file when it closes:
 * a crash loses that segment and nothing before it.
 */
export const makeVoiceCallUsageTracker = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "voice-call-usage.json");

  const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
  const stored = Option.flatMap(contents, decodeUsageEntries);
  if (Option.isSome(contents) && Option.isNone(stored)) {
    yield* Effect.logWarning("voice call: unreadable usage file, starting empty");
  }
  let entries = pruneUsageEntries(
    Option.getOrElse(stored, (): UsageEntries => []),
    yield* Clock.currentTimeMillis,
  );
  let openSince: number | null = null;

  const segmentOpened = Effect.map(Clock.currentTimeMillis, (now) => {
    openSince = now;
  });

  const segmentClosed = Effect.gen(function* () {
    if (openSince === null) return;
    const now = yield* Clock.currentTimeMillis;
    entries = pruneUsageEntries([...entries, { startedAt: openSince, endedAt: now }], now);
    openSince = null;
    yield* writeFileStringAtomically({ filePath, contents: encodeUsageEntries(entries) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catch((error) => Effect.logWarning("voice call: usage not saved", error.message)),
    );
  }).pipe(Effect.uninterruptible);

  const summary = Effect.fnUntraced(function* (planType: string | null) {
    const now = yield* Clock.currentTimeMillis;
    const counted =
      openSince === null ? entries : [...entries, { startedAt: openSince, endedAt: now }];
    return {
      last24HoursSeconds: connectedSeconds(counted, now - DAY_MS, now),
      last30DaysSeconds: connectedSeconds(counted, now - 30 * DAY_MS, now),
      ...voiceCallPlan(planType),
    } satisfies Omit<VoiceCallUsage, "offered">;
  });

  return { segmentOpened, segmentClosed, summary };
});
