import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeTestInitiatives, TEST_PROJECT } from "./testFakes.ts";

const ROBERT = "person:robert";

const quotaAt = (usedPercent: number, checkedAt: string) => ({
  instanceId: "codex",
  driver: "codex",
  usageLimits: {
    checkedAt,
    windows: [
      {
        id: "codex-5h",
        kind: "session" as const,
        label: "5 Stunden",
        usedPercent,
        resetsAt: "2026-09-26T14:00:00.000Z",
      },
    ],
  },
});

describe("InitiativeStats", () => {
  it.effect(
    "measures sessions, shows each beside what the others took and splits the quota by the delta",
    () =>
      Effect.gen(function* () {
        const { initiatives, fake } = yield* makeTestInitiatives;
        const created = yield* initiatives.act(
          { type: "create", title: "Relaunch", goalText: "Ship it" },
          ROBERT,
        );
        const initiativeId = created.id!;
        for (const key of ["a", "b", "c", "d"]) {
          const started = yield* initiatives.act(
            {
              type: "startThread",
              initiativeId,
              key,
              projectId: TEST_PROJECT,
              title: `Task ${key}`,
              prompt: "Do it.",
            },
            ROBERT,
          );
          fake.activity.set(started.id!, {
            turns: 2,
            firstAt: "2026-09-26T10:00:00.000Z",
            lastAt: "2026-09-26T10:30:00.000Z",
          });
        }
        fake.usage.push(quotaAt(20, "2026-09-26T09:00:00.000Z"));
        yield* initiatives.act({ type: "statsRefresh", initiativeId }, ROBERT);
        fake.usage[0] = quotaAt(50, "2026-09-26T11:00:00.000Z");
        assert.equal(yield* initiatives.stats.recordQuota, 1);
        // An unchanged window is not recorded again.
        assert.equal(yield* initiatives.stats.recordQuota, 0);

        const report = yield* initiatives.stats.report(initiativeId);
        assert.equal(report.sessions.length, 4);
        const first = report.sessions[0]!;
        assert.equal(first.stats.apiUsd, 1.5);
        assert.equal(first.stats.turns, 2);
        assert.equal(first.stats.durationMs, 30 * 60 * 1000);
        assert.equal(first.stats.outcome, "done");
        // The other three sessions are the basis, never the session itself.
        assert.equal(first.estimate?.basis, 3);
        assert.equal(first.estimate?.match, "same-model");

        const window = report.quota[0]!;
        assert.equal(window.usedPercent, 50);
        assert.equal(window.observations, 2);
        assert.isAbove(window.initiativePercent, 0);
        assert.equal(window.otherInitiativesPercent, 0);
        assert.closeTo(window.initiativePercent + window.unattributedPercent, 50, 0.2);

        const estimate = yield* initiatives.stats.estimate(initiativeId, "codex", "gpt-6");
        assert.equal(estimate.estimate?.basis, 4);

        // An imported Codex session counts under the codex provider.
        yield* initiatives.store.insert(
          "session",
          {
            initiativeId,
            source: "codex",
            nativeId: "rollout-1",
            environmentId: null,
            threadId: null,
            title: "Earlier work",
            cwd: "/repo/web",
            branch: null,
            assignment: "confirmed",
            launchJobId: null,
            startedAt: "2026-09-26T10:05:00.000Z",
            endedAt: "2026-09-26T10:20:00.000Z",
            prUrls: [],
            model: "gpt-6",
            tokens: 5000,
            summary: null,
          },
          ROBERT,
        );
        yield* initiatives.act({ type: "statsRefresh", initiativeId }, ROBERT);
        const imported = (yield* initiatives.stats.report(initiativeId)).sessions.find(
          (session) => session.title === "Earlier work",
        );
        assert.equal(imported?.stats.provider, "codex");
        assert.equal(
          (yield* initiatives.stats.estimate(initiativeId, "codex", "gpt-6")).estimate?.basis,
          5,
        );
        assert.equal(estimate.quota.length, 1);
        assert.isNull((yield* initiatives.stats.estimate(null, "claudeAgent", null)).estimate);
      }),
  );
});
