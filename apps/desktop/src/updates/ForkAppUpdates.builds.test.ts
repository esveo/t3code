import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import * as ForkAppUpdates from "./ForkAppUpdates.ts";

const environment = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/src",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
}).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));

const electronWindow = Layer.mock(ElectronWindow.ElectronWindow)({
  sendAll: () => Effect.void,
});

it.effect("deletes only a build the update menu lists", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A launcher root with one prepared build and a script that only logs its calls.
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "fork-app-builds-" });
    yield* fileSystem.makeDirectory(path.join(root, "builds", "feat-x"), { recursive: true });
    yield* fileSystem.writeFileString(
      path.join(root, "builds", "feat-x", ".fork-build.json"),
      '{"label":"feat-x@abc1234","branch":"feat-x","builtAt":"2026-09-22T10:00:00Z"}',
    );
    const script = path.join(root, "fork-app.sh");
    yield* fileSystem.writeFileString(
      script,
      '#!/bin/sh\necho "$@" >>"$(dirname "$0")/calls.log"\n',
      { mode: 0o755 },
    );
    const calls = fileSystem.readFileString(path.join(root, "calls.log")).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed((): string[] => []),
    );

    yield* Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      const builds = yield* ForkAppUpdates.ForkAppBuilds;
      // Reads the prepared builds into the state the menu shows.
      yield* updates.download;

      for (const slug of ["..", "../builds", "feat-y"]) {
        const result = yield* builds.act({ kind: "delete", slug });
        assert.isFalse(result.accepted, slug);
      }
      assert.deepStrictEqual(yield* calls, []);

      const result = yield* builds.act({ kind: "delete", slug: "feat-x" });
      assert.isTrue(result.completed);
      assert.deepStrictEqual(yield* calls, ["delete feat-x"]);
    }).pipe(
      Effect.provide(
        Layer.effectContext(ForkAppUpdates.makeForkUpdates({ root, script })).pipe(
          Layer.provide(Layer.mergeAll(environment, electronWindow)),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
