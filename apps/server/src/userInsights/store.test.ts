import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { emptyState } from "./distillPolicy.ts";
import type { EvidenceRecord } from "./evidence.ts";
import { emptyProfile } from "./profileMerge.ts";
import { EVIDENCE_MAX_RECORDS, makeUserInsightsStore, type UsageRecord } from "./store.ts";
import { DAY_MS, toIso } from "./time.ts";

const NOW = Date.UTC(2026, 9, 8, 12);

const TestLayer = ServerConfig.layerTest(process.cwd(), { prefix: "user-insights-store-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const withStore = <A, E>(
  body: (
    store: Effect.Success<ReturnType<typeof makeUserInsightsStore>>,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const store = yield* makeUserInsightsStore(config.stateDir);
    return yield* body(store);
  }).pipe(Effect.provide(TestLayer));

const evidence = (index: number, ts: number): EvidenceRecord => ({
  ts: toIso(ts),
  threadId: "thread",
  projectId: null,
  messageId: `m${index}`,
  chars: 10,
  words: 2,
  lang: "en",
  hasCode: false,
  hasPath: false,
  endsWithQuestion: false,
  excerpt: "hello",
});

const usage = (ts: number): UsageRecord => ({
  ts: toIso(ts),
  purpose: "distill",
  model: "claude-haiku-4-5",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  costEstimated: false,
  durationMs: 10,
  ok: true,
});

describe("user insights store", () => {
  it.effect("reads missing files as empty without creating the folder", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        assert.isNull(yield* store.readProfile);
        assert.isNull(yield* store.readState);
        assert.deepEqual(yield* store.readEvidence, []);
        assert.isFalse(yield* fs.exists(store.directory));
      }),
    ),
  );

  it.effect("appends records and trims old and surplus ones", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.appendEvidence(evidence(0, NOW - 31 * DAY_MS));
        for (let index = 1; index <= EVIDENCE_MAX_RECORDS + 2; index += 1) {
          yield* store.appendEvidence(evidence(index, NOW));
        }
        yield* store.appendUsage(usage(NOW - 91 * DAY_MS));
        yield* store.appendUsage(usage(NOW - DAY_MS));
        yield* store.trim(NOW);
        const kept = yield* store.readEvidence;
        assert.strictEqual(kept.length, EVIDENCE_MAX_RECORDS);
        assert.strictEqual(kept[0]?.messageId, "m3");
        assert.strictEqual((yield* store.readUsage).length, 1);
      }),
    ),
  );

  it.effect("keeps the previous profile and restores it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const first = { ...emptyProfile(NOW), sampleCount: 1 };
        const second = { ...emptyProfile(NOW), sampleCount: 2 };
        yield* store.writeProfile(first);
        yield* store.writeProfile(second);
        assert.strictEqual((yield* store.readPreviousProfile)?.sampleCount, 1);
        assert.isTrue(yield* store.restorePreviousProfile);
        assert.strictEqual((yield* store.readProfile)?.sampleCount, 1);
        assert.isFalse(yield* store.restorePreviousProfile);
      }),
    ),
  );

  it.effect("reads a corrupt file as empty and skips corrupt lines", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* store.appendEvidence(evidence(1, NOW));
        yield* fs.writeFileString(store.files.evidence, "{broken\n", { flag: "a" });
        yield* store.appendEvidence(evidence(2, NOW));
        yield* fs.writeFileString(store.files.profile, "{not json");
        assert.isNull(yield* store.readProfile);
        assert.deepEqual(
          (yield* store.readEvidence).map((record) => record.messageId),
          ["m1", "m2"],
        );
      }),
    ),
  );

  it.effect("reset keeps the usage ledger; deleteAll removes the folder", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* store.appendEvidence(evidence(1, NOW));
        yield* store.appendUsage(usage(NOW));
        yield* store.writeProfile(emptyProfile(NOW));
        yield* store.writeState(emptyState(NOW));
        yield* store.reset;
        assert.isNull(yield* store.readProfile);
        assert.isNull(yield* store.readState);
        assert.deepEqual(yield* store.readEvidence, []);
        assert.strictEqual((yield* store.readUsage).length, 1);
        yield* store.deleteAll;
        assert.isFalse(yield* fs.exists(store.directory));
      }),
    ),
  );
});
