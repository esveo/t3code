import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { threadRoots } from "./threadRoots.ts";

const HOME = "/home/me";

const instances = (
  entries: Record<string, { driver: string; homePath?: string; env?: Record<string, string> }>,
): ServerSettings["providerInstances"] =>
  Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      ProviderInstanceId.make(id),
      {
        driver: ProviderDriverKind.make(entry.driver),
        config: { homePath: entry.homePath ?? "" },
        environment: Object.entries(entry.env ?? {}).map(([name, value]) => ({
          name,
          value,
          sensitive: false,
        })),
      },
    ]),
  ) as ServerSettings["providerInstances"];

const roots = (input: {
  provider?: "claude" | "codex";
  threadInstanceId: string;
  providerInstances?: ServerSettings["providerInstances"];
  environment?: NodeJS.ProcessEnv;
}) =>
  threadRoots({
    provider: input.provider,
    threadInstanceId: input.threadInstanceId,
    checkout: "/repo/worktree",
    providerInstances: input.providerInstances ?? {},
    environment: input.environment ?? {},
    home: HOME,
  });

it.layer(NodeServices.layer)("forkInstructions threadRoots", (it) => {
  it.effect("defaults to the thread's provider, Claude for any other", () =>
    Effect.gen(function* () {
      assert.equal((yield* roots({ threadInstanceId: "codex" })).provider, "codex");
      assert.equal((yield* roots({ threadInstanceId: "claudeAgent" })).provider, "claude");
      assert.equal((yield* roots({ threadInstanceId: "opencode" })).provider, "claude");
      const custom = instances({ work: { driver: "codex" } });
      assert.equal(
        (yield* roots({ threadInstanceId: "work", providerInstances: custom })).provider,
        "codex",
      );
      assert.equal(
        (yield* roots({ provider: "codex", threadInstanceId: "claudeAgent" })).provider,
        "codex",
      );
    }),
  );

  it.effect("homes come from the instance's homePath, then the environment, then ~", () =>
    Effect.gen(function* () {
      const plain = yield* roots({ threadInstanceId: "claudeAgent" });
      assert.equal(plain.roots.claudeConfigDir, "/home/me/.claude");
      assert.equal(plain.roots.codexHome, "/home/me/.codex");
      assert.equal(plain.roots.checkout, "/repo/worktree");

      const fromEnv = yield* roots({
        threadInstanceId: "claudeAgent",
        environment: { CLAUDE_CONFIG_DIR: "/cfg/claude" },
      });
      assert.equal(fromEnv.roots.claudeConfigDir, "/cfg/claude");

      const configured = instances({
        work: { driver: "codex", homePath: "~/.codex_work" },
        claudeAgent: { driver: "claudeAgent", env: { CLAUDE_CONFIG_DIR: "/instance/claude" } },
      });
      const work = yield* roots({ threadInstanceId: "work", providerInstances: configured });
      assert.equal(work.roots.codexHome, "/home/me/.codex_work");
      // Switching to Claude in a Codex thread takes Claude's default instance.
      const claude = yield* roots({
        provider: "claude",
        threadInstanceId: "work",
        providerInstances: configured,
        environment: { CLAUDE_CONFIG_DIR: "/process/claude" },
      });
      assert.equal(claude.roots.claudeConfigDir, "/instance/claude");
    }),
  );
});
