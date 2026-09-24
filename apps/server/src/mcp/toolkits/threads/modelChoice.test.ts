import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { chooseModelSelection, listProviderModels } from "./modelChoice.ts";

const model = (
  slug: string,
  overrides: Partial<ServerProviderModel> = {},
): ServerProviderModel => ({
  slug,
  name: slug.toUpperCase(),
  isCustom: false,
  capabilities: null,
  ...overrides,
});

const makeProvider = (
  instanceId: string,
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-23T10:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
  ...overrides,
});

const providers = [
  makeProvider("claudeAgent", [
    model("opus", { aliases: ["claude-opus"] }),
    model("sonnet", { isDefault: true }),
    model("claude-2", { isLegacy: true }),
  ]),
  makeProvider("codex", [model("gpt-5", { isDefault: true }), model("gpt-5-mini")]),
  makeProvider("opencode", []),
  makeProvider("cursor", [model("auto")], { enabled: false }),
];
const current = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };

describe("listProviderModels", () => {
  it("lists the usable providers with their current models", () => {
    expect(listProviderModels(providers, "claudeAgent")).toEqual([
      { provider: "claudeAgent", name: "claudeAgent", models: ["opus", "sonnet"], current: true },
      { provider: "codex", name: "codex", models: ["gpt-5", "gpt-5-mini"], current: false },
      { provider: "opencode", name: "opencode", models: [], current: false },
    ]);
  });
});

describe("chooseModelSelection", () => {
  const choose = (pick: { provider?: string; model?: string }) =>
    chooseModelSelection({ providers, current, ...pick });

  it("keeps the coordinator's selection without a pick", () => {
    expect(choose({})).toEqual({ selection: current });
    expect(choose({ provider: "claudeAgent" })).toEqual({ selection: current });
  });

  it("resolves a model by id, name or alias", () => {
    expect(choose({ model: "sonnet" })).toEqual({
      selection: { instanceId: "claudeAgent", model: "sonnet" },
    });
    expect(choose({ model: "claude-opus" })).toEqual({
      selection: { instanceId: "claudeAgent", model: "opus" },
    });
    expect(choose({ provider: "codex", model: "GPT-5-MINI" })).toEqual({
      selection: { instanceId: "codex", model: "gpt-5-mini" },
    });
  });

  it("takes another provider's default model when none is named", () => {
    expect(choose({ provider: "codex" })).toEqual({
      selection: { instanceId: "codex", model: "gpt-5" },
    });
  });

  it("refuses unknown or turned-off providers and names the valid ones", () => {
    expect(choose({ provider: "gemini" })).toEqual({
      error:
        "Unknown provider gemini. Providers: claudeAgent, codex, opencode. list_projects lists them with their models.",
    });
    expect(choose({ provider: "cursor" })).toMatchObject({
      error: expect.stringContaining("Provider cursor is turned off or unavailable"),
    });
  });

  it("refuses a model the provider does not have and names its models", () => {
    expect(choose({ provider: "codex", model: "opus" })).toEqual({
      error: "opus is not a model of codex. Models: gpt-5, gpt-5-mini.",
    });
  });

  it("passes any model on when the provider decides its models at runtime", () => {
    expect(choose({ provider: "opencode", model: "anthropic/claude-x" })).toEqual({
      selection: { instanceId: "opencode", model: "anthropic/claude-x" },
    });
  });

  it("does not refuse while the provider list has not loaded", () => {
    expect(
      chooseModelSelection({ providers: [], current, provider: "codex", model: "gpt-9" }),
    ).toEqual({ selection: { instanceId: "codex", model: "gpt-9" } });
  });
});
