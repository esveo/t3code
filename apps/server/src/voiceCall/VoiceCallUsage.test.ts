import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { codexPlanTypeFromFile } from "./VoiceCallAuth.ts";
import {
  connectedSeconds,
  makeVoiceCallUsageTracker,
  pruneUsageEntries,
  voiceCallPlan,
} from "./VoiceCallUsage.ts";

const DAY_MS = 86_400_000;
const NOW = 100 * DAY_MS;

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "voice-call-usage-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const authFile = (claims: unknown, authMode = "chatgpt") =>
  JSON.stringify({
    auth_mode: authMode,
    tokens: {
      access_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`,
      account_id: "account-1",
    },
  });

describe("connectedSeconds", () => {
  it("sums only the part of each entry inside the window", () => {
    const entries = [
      { startedAt: NOW - 3 * DAY_MS, endedAt: NOW - 2 * DAY_MS },
      // Straddles the start of the 24 hours: only its last minute counts.
      { startedAt: NOW - DAY_MS - 60_000, endedAt: NOW - DAY_MS + 60_000 },
      { startedAt: NOW - 30_000, endedAt: NOW },
    ];
    assert.equal(connectedSeconds(entries, NOW - DAY_MS, NOW), 90);
    assert.equal(connectedSeconds(entries, NOW - 30 * DAY_MS, NOW), 86_400 + 150);
  });

  it("does not let a clock that jumped back subtract time", () => {
    assert.equal(connectedSeconds([{ startedAt: NOW, endedAt: NOW - 5_000 }], 0, NOW), 0);
  });
});

describe("pruneUsageEntries", () => {
  it("keeps the last 35 days", () => {
    const kept = { startedAt: NOW - 35 * DAY_MS + 1_000, endedAt: NOW - 35 * DAY_MS + 2_000 };
    const dropped = { startedAt: NOW - 36 * DAY_MS, endedAt: NOW - 35 * DAY_MS };
    assert.deepEqual(pruneUsageEntries([dropped, kept], NOW), [kept]);
  });
});

describe("voice call plan", () => {
  it("reads the plan claim from the login", () => {
    const claims = { "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
    assert.equal(codexPlanTypeFromFile(authFile(claims)), "plus");
    assert.isNull(codexPlanTypeFromFile(authFile(claims, "apikey")));
    assert.isNull(codexPlanTypeFromFile(authFile({})));
    assert.isNull(codexPlanTypeFromFile("not json"));
  });

  it("has a bar only for plans with a published limit", () => {
    assert.equal(voiceCallPlan("plus").limitSeconds, 3 * 3_600);
    assert.equal(voiceCallPlan("prolite").limitSeconds, 15 * 3_600);
    assert.isNull(voiceCallPlan("pro").limitSeconds);
    assert.isNull(voiceCallPlan("free").limitSeconds);
    assert.deepEqual(voiceCallPlan("constructor"), { planLabel: null, limitSeconds: null });
    assert.deepEqual(voiceCallPlan(null), { planLabel: null, limitSeconds: null });
  });
});

describe("makeVoiceCallUsageTracker", () => {
  it.effect("survives a restart, and a crash loses only the open segment", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const first = yield* makeVoiceCallUsageTracker;
      yield* first.segmentOpened;
      yield* TestClock.adjust("90 seconds");
      yield* first.segmentClosed;
      yield* TestClock.adjust("10 minutes");
      yield* first.segmentOpened;
      yield* TestClock.adjust("20 seconds");
      assert.equal((yield* first.summary(null)).last24HoursSeconds, 110);

      // The second segment never closes: the process died.
      const second = yield* makeVoiceCallUsageTracker;
      const usage = yield* second.summary("plus");
      assert.equal(usage.last24HoursSeconds, 90);
      assert.equal(usage.limitSeconds, 3 * 3_600);

      yield* TestClock.adjust("2 days");
      const later = yield* second.summary(null);
      assert.equal(later.last24HoursSeconds, 0);
      assert.equal(later.last30DaysSeconds, 90);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("closing without an open segment adds nothing", () =>
    Effect.gen(function* () {
      const tracker = yield* makeVoiceCallUsageTracker;
      yield* tracker.segmentClosed;
      assert.equal((yield* tracker.summary(null)).last30DaysSeconds, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drops entries past the retention from the file on the next close", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { stateDir } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(stateDir, "voice-call-usage.json");
      yield* fs.writeFileString(
        file,
        JSON.stringify([{ startedAt: NOW - 40 * DAY_MS, endedAt: NOW - 39 * DAY_MS }]),
      );
      const tracker = yield* makeVoiceCallUsageTracker;
      yield* tracker.segmentOpened;
      yield* TestClock.adjust("1 second");
      yield* tracker.segmentClosed;
      assert.deepEqual(JSON.parse(yield* fs.readFileString(file)), [
        { startedAt: NOW, endedAt: NOW + 1_000 },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("starts empty from an unreadable file", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(stateDir, "voice-call-usage.json"), "{ not json");
      const tracker = yield* makeVoiceCallUsageTracker;
      assert.equal((yield* tracker.summary(null)).last30DaysSeconds, 0);
    }).pipe(Effect.provide(layer)),
  );
});
