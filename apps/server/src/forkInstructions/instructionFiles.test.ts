import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  importOnlyTargets,
  type InstructionRoots,
  readSnapshot,
  resolveLocation,
  writeFile,
} from "./instructionFiles.ts";

/** A fake home with a checkout and both provider homes inside it. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const roots: InstructionRoots = {
    home,
    checkout: path.join(home, "repo"),
    claudeConfigDir: path.join(home, ".claude"),
    codexHome: path.join(home, ".codex"),
  };
  yield* fs.makeDirectory(roots.checkout, { recursive: true });
  const put = (relative: string, content: string) =>
    Effect.gen(function* () {
      const file = path.join(home, relative);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, content);
    });
  return { fs, path, home, roots, put };
});

describe("importOnlyTargets", () => {
  it("lists the imports of a file that only imports", () => {
    assert.deepEqual(importOnlyTargets("@AGENTS.md\n\n@FORK.md\n"), ["AGENTS.md", "FORK.md"]);
    assert.isNull(importOnlyTargets("@AGENTS.md\nAlso run the tests."));
    assert.isNull(importOnlyTargets(""));
    assert.isNull(importOnlyTargets("@~/.ssh/authorized_keys"));
  });
});

it.layer(NodeServices.layer)("forkInstructions files", (it) => {
  it.effect(
    "Claude's project file is CLAUDE.md, else .claude/CLAUDE.md, new files at the root",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { path, roots, put } = yield* setup;
          const fresh = yield* resolveLocation("claude", "project", roots);
          assert.equal(fresh.entry, path.join(roots.checkout, "CLAUDE.md"));

          yield* put("repo/.claude/CLAUDE.md", "nested");
          yield* put("repo/CLAUDE.local.md", "local");
          const nested = yield* resolveLocation("claude", "project", roots);
          assert.equal(nested.entry, path.join(roots.checkout, ".claude", "CLAUDE.md"));
          assert.deepEqual(nested.alsoRead, ["~/repo/CLAUDE.local.md loads too."]);

          const global = yield* resolveLocation("claude", "global", roots);
          assert.equal(global.entry, path.join(roots.claudeConfigDir, "CLAUDE.md"));
        }),
      ),
  );

  it.effect("Claude's project file is AGENTS.md while the project has no CLAUDE.md", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { path, roots, put } = yield* setup;
        yield* put("repo/AGENTS.md", "shared");
        const location = yield* resolveLocation("claude", "project", roots);
        assert.equal(location.entry, path.join(roots.checkout, "AGENTS.md"));
        yield* put("repo/CLAUDE.md", "own");
        const own = yield* resolveLocation("claude", "project", roots);
        assert.equal(own.entry, path.join(roots.checkout, "CLAUDE.md"));
      }),
    ),
  );

  it.effect("Codex prefers AGENTS.override.md, at home only when it has text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { path, roots, put } = yield* setup;
        yield* put("repo/AGENTS.md", "plain");
        yield* put("repo/AGENTS.override.md", "");
        const project = yield* resolveLocation("codex", "project", roots);
        assert.equal(project.entry, path.join(roots.checkout, "AGENTS.override.md"));
        assert.deepEqual(project.alsoRead, [
          "~/repo/AGENTS.md is ignored while ~/repo/AGENTS.override.md exists.",
        ]);

        yield* put(".codex/AGENTS.override.md", "  \n");
        const global = yield* resolveLocation("codex", "global", roots);
        assert.equal(global.entry, path.join(roots.codexHome, "AGENTS.md"));
      }),
    ),
  );

  it.effect("opens the first import of an import-only file and offers the others", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { path, home, roots, put } = yield* setup;
        yield* put("repo/CLAUDE.md", "@AGENTS.md\n@~/shared/FORK.md\n");
        yield* put("repo/AGENTS.md", "agents");
        const location = yield* resolveLocation("claude", "project", roots);
        const snapshot = yield* readSnapshot(location, home, undefined);
        assert.equal(snapshot.path, path.join(roots.checkout, "AGENTS.md"));
        assert.equal(snapshot.content, "agents");
        assert.deepEqual(
          snapshot.choices.map((choice) => [choice.displayPath, choice.kind, choice.exists]),
          [
            ["~/repo/AGENTS.md", "import", true],
            ["~/shared/FORK.md", "import", false],
            ["~/repo/CLAUDE.md", "entry", true],
          ],
        );

        const entry = yield* readSnapshot(location, home, location.entry);
        assert.equal(entry.content, "@AGENTS.md\n@~/shared/FORK.md\n");
        const refused = yield* readSnapshot(location, home, "/etc/hosts").pipe(Effect.flip);
        assert.equal(refused._tag, "ForkInstructionsError");
      }),
    ),
  );

  it.effect("Codex does not follow imports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, roots, put } = yield* setup;
        yield* put("repo/AGENTS.md", "@OTHER.md");
        const location = yield* resolveLocation("codex", "project", roots);
        const snapshot = yield* readSnapshot(location, home, undefined);
        assert.equal(snapshot.path, location.entry);
        assert.deepEqual(snapshot.choices, []);
      }),
    ),
  );

  it.effect("creates a missing file and rejects a write over a newer version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fs, home, roots } = yield* setup;
        const location = yield* resolveLocation("claude", "global", roots);
        const missing = yield* readSnapshot(location, home, undefined);
        assert.isFalse(missing.exists);
        assert.isNull(missing.version);

        const saved = yield* writeFile(location, home, {
          file: location.entry,
          content: "mine",
          expectedVersion: null,
        });
        assert.equal(yield* fs.readFileString(location.entry), "mine");

        // An agent edits the file meanwhile.
        yield* fs.writeFileString(location.entry, "agent");
        const conflict = yield* writeFile(location, home, {
          file: location.entry,
          content: "stale",
          expectedVersion: saved.version,
        }).pipe(Effect.flip);
        assert.equal(conflict._tag, "ForkInstructionsConflictError");
        assert.equal(yield* fs.readFileString(location.entry), "agent");

        const forced = yield* writeFile(location, home, {
          file: location.entry,
          content: "stale",
          expectedVersion: saved.version,
          force: true,
        });
        assert.equal(forced.content, "stale");
      }),
    ),
  );
});
