// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { makeBrainArchive } from "./BrainArchive.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeArchive = Effect.gen(function* () {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-brain-"));
  return { root, archive: yield* makeBrainArchive(root) };
});

describe("BrainArchive", () => {
  it.effect("commits every change and nothing for an unchanged page", () =>
    Effect.gen(function* () {
      const { archive } = yield* makeArchive;
      const created = yield* archive.ensure(
        "i1",
        [{ path: "index.md", markdown: "# Index" }],
        "person:robert",
      );
      assert.isTrue(created.created);
      assert.isFalse((yield* archive.ensure("i1", [], "person:robert")).created);

      const first = yield* archive.write("i1", {
        path: "details/api.md",
        markdown: "# API\nREST",
        author: "role:coordinator:t1",
        message: "Describe the API",
      });
      assert.isTrue(first.changed);
      const same = yield* archive.write("i1", {
        path: "details/api.md",
        markdown: "# API\nREST",
        author: "role:coordinator:t1",
        message: "Again",
      });
      assert.isFalse(same.changed);
      assert.equal(same.commit, first.commit);

      const history = yield* archive.history("i1", "details/api.md", 10);
      assert.equal(history.length, 1);
      assert.equal(history[0]?.author, "role:coordinator:t1");
      assert.equal(history[0]?.message, "Describe the API");
      assert.equal(yield* archive.read("i1", "details/api.md"), "# API\nREST\n");

      const hits = yield* archive.search("i1", "rest", 10);
      assert.deepEqual(
        hits.map((hit) => [hit.path, hit.line]),
        [["details/api.md", 2]],
      );
      const pages = yield* archive.pages("i1");
      assert.deepEqual(pages.map((page) => page.path).toSorted(), ["details/api.md", "index.md"]);
    }).pipe(Effect.provide(services)),
  );

  it.effect("commits what a crash left behind when the server starts again", () =>
    Effect.gen(function* () {
      const { root, archive } = yield* makeArchive;
      yield* archive.ensure("i1", [{ path: "index.md", markdown: "# Index" }], "person:robert");
      NodeFS.writeFileSync(
        NodePath.join(root, "i1", "brain", "index.md"),
        "# Index\n- half written\n",
      );
      const commit = yield* archive.recover("i1");
      assert.isNotNull(commit);
      assert.isNull(yield* archive.recover("i1"));
      const history = yield* archive.history("i1", "index.md", 10);
      assert.equal(history[0]?.author, "system:recover");
    }).pipe(Effect.provide(services)),
  );
});
